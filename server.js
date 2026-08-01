const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// TrainingPeaks endpoints
const HOME_BASE = 'https://home.trainingpeaks.com';
const API_BASE = 'https://tpapi.trainingpeaks.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// How much of the calendar to pull, in days relative to today
const DAYS_BACK = parseInt(process.env.TP_DAYS_BACK || '30', 10);
const DAYS_FORWARD = parseInt(process.env.TP_DAYS_FORWARD || '60', 10);

// Load users from environment variables
function loadUsersFromEnv() {
  const users = {};
  const envKeys = Object.keys(process.env);
  const userKeys = envKeys
    .filter(k => k.startsWith('TP_') && k.endsWith('_USERNAME'))
    .map(k => k.slice(3, -9).toLowerCase());

  for (const userKey of userKeys) {
    const envPrefix = `TP_${userKey.toUpperCase()}`;
    const username = process.env[`${envPrefix}_USERNAME`];
    const password = process.env[`${envPrefix}_PASSWORD`];
    if (username && password) {
      users[userKey] = { username, password };
    }
  }
  return users;
}

const USERS = loadUsersFromEnv();

if (Object.keys(USERS).length === 0) {
  console.error('No users configured. Set TP_<USER>_USERNAME and TP_<USER>_PASSWORD env vars.');
  process.exit(1);
}

// Per-user cache
const cache = {};
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const SECRET = process.env.API_SECRET;

if (!SECRET) {
  console.error('API_SECRET env var required');
  process.exit(1);
}

// Auth middleware - require ?secret=xxx
function requireSecret(req, res, next) {
  if (req.query.secret !== SECRET) {
    return res.status(404).send('Not found');
  }
  next();
}

app.use(requireSecret);

// --- Minimal cookie jar helpers (name -> value) ---
function mergeSetCookies(jar, setCookieList) {
  for (const sc of setCookieList || []) {
    const pair = sc.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Calendar window (YYYY-MM-DD) relative to today
function calendarRange() {
  const fmt = (d) => d.toISOString().split('T')[0];
  const start = new Date();
  start.setDate(start.getDate() - DAYS_BACK);
  const end = new Date();
  end.setDate(end.getDate() + DAYS_FORWARD);
  return { start: fmt(start), end: fmt(end) };
}

/**
 * Logs in to TrainingPeaks over HTTP (no browser) and returns the API bearer
 * token plus the athlete id.
 *
 * The login page carries an anti-CSRF token and, since mid-2026, an (invisible)
 * reCAPTCHA v3 challenge and MFA fields. reCAPTCHA v3 is score-based and the
 * form submits fine with an empty CaptchaToken, so we post the standard fields
 * and let the server score the request.
 */
async function loginToTrainingPeaks(userKey) {
  const user = USERS[userKey];
  const jar = {};

  // 1. Load the login page for the CSRF token + verification cookie
  const pageResp = await fetch(`${HOME_BASE}/login`, { headers: { 'User-Agent': USER_AGENT } });
  mergeSetCookies(jar, pageResp.headers.getSetCookie());
  const html = await pageResp.text();
  const csrf = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
  if (!csrf) {
    throw new Error('Login page structure changed: could not find __RequestVerificationToken');
  }

  // 2. Post credentials
  const body = new URLSearchParams({
    __RequestVerificationToken: csrf,
    CaptchaHidden: 'true',
    CaptchaToken: '',
    Attempts: '',
    SelectedMfaMethod: '',
    Username: user.username,
    Password: user.password
  });
  const loginResp = await fetch(`${HOME_BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(jar)
    },
    body
  });
  mergeSetCookies(jar, loginResp.headers.getSetCookie());

  // 3. Success is signalled by the auth cookie. If it's missing, explain why.
  if (!jar['Production_tpAuth']) {
    const location = loginResp.headers.get('location') || '';
    const respHtml = await loginResp.text().catch(() => '');
    let reason = `HTTP ${loginResp.status}${location ? `, redirect -> ${location}` : ''}`;
    if (/loginfailed/i.test(location) || /invalid|incorrect/i.test(respHtml)) {
      reason += ' (invalid username or password)';
    } else if (/mfa|multi-factor|verification code|SelectedMfaMethod/i.test(respHtml)) {
      reason += ' (account requires MFA, which this tool does not support)';
    } else if (/captcha|recaptcha|are you a robot/i.test(respHtml)) {
      reason += ' (blocked by captcha)';
    }
    throw new Error(`Login failed for ${userKey}: ${reason}`);
  }
  console.log(`[${userKey}] Login OK`);

  // 4. Exchange the session cookie for an API bearer token
  const tokenResp = await fetch(`${API_BASE}/users/v3/token`, {
    headers: { 'User-Agent': USER_AGENT, 'Cookie': cookieHeader(jar) }
  });
  if (!tokenResp.ok) throw new Error(`Token request failed: HTTP ${tokenResp.status}`);
  const bearer = (await tokenResp.json())?.token?.access_token;
  if (!bearer) throw new Error('No access_token returned by /users/v3/token');

  // 5. Look up the athlete id
  const userResp = await fetch(`${API_BASE}/users/v3/user`, {
    headers: { 'User-Agent': USER_AGENT, 'Authorization': `Bearer ${bearer}` }
  });
  if (!userResp.ok) throw new Error(`User lookup failed: HTTP ${userResp.status}`);
  const athleteId = (await userResp.json())?.user?.userId;
  if (!athleteId) throw new Error('Could not determine athlete id from /users/v3/user');

  return { bearer, athleteId };
}

/**
 * Fetches workouts from TrainingPeaks for a specific user via the public app API.
 */
async function fetchWorkoutsFromTrainingPeaks(userKey) {
  const user = USERS[userKey];
  if (!user) throw new Error(`Unknown user: ${userKey}`);

  console.log(`[${userKey}] Fetching workouts...`);
  const { bearer, athleteId } = await loginToTrainingPeaks(userKey);
  const authHeaders = { 'User-Agent': USER_AGENT, 'Authorization': `Bearer ${bearer}` };

  // Athlete settings hold FTP / threshold pace used to resolve power & pace targets.
  let athleteSettings = null;
  try {
    const settingsResp = await fetch(`${API_BASE}/fitness/v1/athletes/${athleteId}/settings`, { headers: authHeaders });
    if (settingsResp.ok) {
      athleteSettings = await settingsResp.json();
    } else {
      console.warn(`[${userKey}] settings HTTP ${settingsResp.status} - power/pace targets will fall back to RPE`);
    }
  } catch (e) {
    console.warn(`[${userKey}] settings fetch error: ${e.message}`);
  }

  // Workouts across the calendar window
  const { start, end } = calendarRange();
  console.log(`[${userKey}] Fetching workouts ${start} -> ${end} for athlete ${athleteId}`);
  const woResp = await fetch(`${API_BASE}/fitness/v6/athletes/${athleteId}/workouts/${start}/${end}`, { headers: authHeaders });
  if (!woResp.ok) throw new Error(`Workouts request failed: HTTP ${woResp.status}`);
  const apiWorkouts = await woResp.json();
  console.log(`[${userKey}] Retrieved ${Array.isArray(apiWorkouts) ? apiWorkouts.length : 0} workouts from API`);

  // Each API record already unifies planned + actual data, so map directly.
  const workouts = (Array.isArray(apiWorkouts) ? apiWorkouts : [])
    .filter(api => !api.isHidden)
    .map(api => {
      const isCompleted = typeof api.totalTime === 'number' && api.totalTime > 0;
      return {
        title: api.title || 'Workout',
        date: api.workoutDay?.split('T')[0] || null,
        type: api.workoutTypeValueId,
        emoji: workoutEmoji(api.workoutTypeValueId),
        duration: isCompleted ? formatDurationHours(api.totalTime) : formatDurationHours(api.totalTimePlanned),
        distance: formatDistance(api.distance || api.distancePlanned),
        tss: (api.tssActual || api.tssPlanned) ? `${Math.round(api.tssActual || api.tssPlanned)} TSS` : null,
        isPlanned: !isCompleted,
        description: api.description || api.coachComments || null,
        steps: formatSteps(api.structure, api.workoutTypeValueId, athleteSettings)
      };
    })
    .sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

  console.log(`[${userKey}] Processed ${workouts.length} workouts`);

  return {
    user: userKey,
    workouts,
    totalCount: workouts.length,
    plannedCount: workouts.filter(w => w.isPlanned).length,
    completedCount: workouts.filter(w => !w.isPlanned).length,
    fetchedAt: new Date().toISOString()
  };
}

function workoutEmoji(typeId) {
  const emojis = {
    1: '🏊', // Swimming
    2: '🚴', // Cycling
    3: '🏃', // Running
    7: '😴', // Rest
    9: '💪', // Strength
    100: '🔄' // Transition
  };
  return emojis[typeId] || '🏋️';
}

function formatDurationHours(hours) {
  if (typeof hours !== 'number' || hours <= 0) return null;
  const totalSeconds = Math.round(hours * 3600);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDistance(meters) {
  if (typeof meters !== 'number') return null;
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatSteps(structure, workoutType, athleteSettings) {
  if (!structure?.structure) return null;

  // Get FTP for power-based workouts (cycling = type 2)
  let ftp = null;
  if (workoutType === 2 && athleteSettings?.powerZones) {
    const powerZone = athleteSettings.powerZones.find(z => z.workoutTypeId === 2);
    if (powerZone) {
      ftp = powerZone.threshold;
    }
  }

  // Get threshold pace for running (type 3) - stored as m/s
  let runThreshold = null;
  if (workoutType === 3 && athleteSettings?.speedZones) {
    const speedZone = athleteSettings.speedZones.find(z => z.workoutTypeId === 3);
    if (speedZone) {
      runThreshold = speedZone.threshold;
    }
  }

  const formatLen = (len) => {
    if (!len) return '';
    if (len.unit === 'meter') {
      return len.value >= 1000 ? `${len.value / 1000} km` : `${len.value} m`;
    }
    if (len.unit === 'second') {
      const mins = Math.floor(len.value / 60);
      const secs = len.value % 60;
      if (mins > 0 && secs > 0) return `${mins}:${String(secs).padStart(2, '0')}`;
      if (mins > 0) return `${mins} min`;
      return `0:${String(secs).padStart(2, '0')}`;
    }
    if (len.unit === 'minute') return `${len.value} min`;
    return `${len.value} ${len.unit}`;
  };

  const formatTarget = (targets) => {
    if (!targets || !targets[0]) return '';
    const t = targets[0];

    // For cycling (type 2) with FTP, show both percentage and watts
    if (workoutType === 2 && ftp && t.minValue > 10) {
      // Values > 10 are likely percentages (FTP%) not RPE
      if (t.maxValue) {
        const minWatts = Math.round(ftp * t.minValue / 100);
        const maxWatts = Math.round(ftp * t.maxValue / 100);
        return ` @ ${t.minValue}-${t.maxValue}% (${minWatts}-${maxWatts}W)`;
      } else {
        const watts = Math.round(ftp * t.minValue / 100);
        return ` @ ${t.minValue}% (${watts}W)`;
      }
    }

    // For running (type 3) with threshold, convert pace percentages to min/km
    if (workoutType === 3 && runThreshold && t.minValue > 10) {
      const paceFromPercent = (pct) => {
        const speed = runThreshold * pct / 100;  // m/s
        const secPerKm = 1000 / speed;
        const mins = Math.floor(secPerKm / 60);
        const secs = Math.round(secPerKm % 60);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      };
      // Lower % = slower speed = higher pace number, so swap min/max for display
      if (t.maxValue) {
        return ` @ ${paceFromPercent(t.maxValue)}-${paceFromPercent(t.minValue)} min/km`;
      } else {
        return ` @ ${paceFromPercent(t.minValue)} min/km`;
      }
    }

    // For swimming or low values, show as RPE
    if (t.minValue && t.maxValue) {
      return ` @ ${t.minValue}-${t.maxValue} RPE`;
    } else if (t.minValue) {
      return ` @ ${t.minValue} RPE`;
    }
    return '';
  };

  // Format a single step as multi-line
  const formatStepMultiline = (step, indent = '') => {
    const name = step.name || step.intensityClass || 'Step';
    const duration = formatLen(step.length);
    const target = formatTarget(step.targets);
    const lines = [name];
    if (duration || target) {
      lines.push(`${indent}${duration}${target}`);
    }
    if (step.notes) {
      lines.push(`${indent}Notes - ${step.notes}`);
    }
    return lines.join('\n');
  };

  // Format step for bullet point (single line)
  const formatStepBullet = (step) => {
    const name = step.name || step.intensityClass || 'Step';
    const duration = formatLen(step.length);
    const target = formatTarget(step.targets);
    let line = `${name} ${duration}${target}`;
    if (step.notes) {
      line += `\n      Notes - ${step.notes}`;
    }
    return line;
  };

  const steps = [];
  for (const block of structure.structure) {
    const reps = block.length?.unit === 'repetition' ? block.length.value : 1;
    const blockSteps = block.steps || [];

    if (blockSteps.length === 0) continue;

    if (blockSteps.length === 1) {
      // Single step
      const step = blockSteps[0];
      const name = step.name || step.intensityClass || 'Step';
      const duration = formatLen(step.length);
      const target = formatTarget(step.targets);

      let stepText = reps > 1 ? `${reps}x ${name}` : name;
      if (duration || target) {
        stepText += `\n   ${duration}${target}`;
      }
      if (step.notes) {
        stepText += `\n   Notes - ${step.notes}`;
      }
      steps.push(stepText);
    } else {
      // Multiple steps grouped - use "Repeat X times" with bullets
      const header = reps > 1 ? `Repeat ${reps} times` : 'Set';
      const bullets = blockSteps.map(s => `   • ${formatStepBullet(s)}`).join('\n');
      steps.push(`${header}\n${bullets}`);
    }
  }
  return steps.length > 0 ? steps : null;
}

/**
 * Get workouts with per-user caching
 */
async function getWorkouts(userKey) {
  if (!USERS[userKey]) throw new Error(`Unknown user: ${userKey}`);

  const now = Date.now();

  if (cache[userKey] && (now - cache[userKey].timestamp) < CACHE_DURATION_MS) {
    console.log(`Returning cached workouts for ${userKey}`);
    return {
      ...cache[userKey].data,
      cached: true,
      cacheAge: Math.round((now - cache[userKey].timestamp) / 1000) + ' seconds'
    };
  }

  console.log(`Fetching fresh data for ${userKey}...`);
  const workouts = await fetchWorkoutsFromTrainingPeaks(userKey);

  cache[userKey] = {
    data: workouts,
    timestamp: now
  };

  return { ...workouts, cached: false };
}

/**
 * Format workouts as Markdown
 */
function formatAsMarkdown(data) {
  let md = `# TrainingPeaks Workouts - ${data.user.charAt(0).toUpperCase() + data.user.slice(1)}\n\n`;
  md += `_Last updated: ${data.fetchedAt}_\n`;
  md += `_Total: ${data.totalCount} workouts (${data.plannedCount} planned, ${data.completedCount} completed)_\n\n`;

  const byDate = {};
  data.workouts.forEach(w => {
    const date = w.date || 'No Date';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(w);
  });

  const sortedDates = Object.keys(byDate).sort();

  for (const date of sortedDates) {
    const workouts = byDate[date];
    md += `## ${date}\n\n`;
    workouts.forEach(w => {
      const status = w.isPlanned ? '⏳' : '✅';
      md += `### ${w.emoji} ${status} ${w.title}\n\n`;
      if (w.duration) md += `- **Duration:** ${w.duration}\n`;
      if (w.distance) md += `- **Distance:** ${w.distance}\n`;
      if (w.tss) md += `- **TSS:** ${w.tss}\n`;
      if (w.description) md += `\n${w.description}\n`;
      if (w.steps) md += `\n**Steps:**\n\n${w.steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}\n`;
      md += '\n';
    });
    md += '---\n\n';
  }

  return md;
}

/**
 * Format workouts as ICS calendar feed
 */
function formatAsICS(data) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TrainingPeaks Workout Extractor//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:TrainingPeaks - ${data.user.charAt(0).toUpperCase() + data.user.slice(1)}`,
    'X-WR-TIMEZONE:Australia/Melbourne'
  ];

  data.workouts.forEach((workout, index) => {
    let eventDate = parseWorkoutDate(workout.date);
    if (!eventDate) eventDate = new Date();

    const nextDay = new Date(eventDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const endDateStr = formatICSDate(nextDay);

    const uid = `workout-${data.user}-${index}-${eventDate.getTime()}@trainingpeaks`;
    const dateStr = formatICSDate(eventDate);

    let description = '';
    if (workout.duration) description += `Duration: ${workout.duration}\n`;
    if (workout.distance) description += `Distance: ${workout.distance}\n`;
    if (workout.tss) description += `TSS: ${workout.tss}\n`;
    if (workout.description) description += `\n${workout.description}`;
    if (workout.steps) description += `\n\nSteps:\n\n${workout.steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n')}`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${formatICSDateTime(new Date())}`);
    lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
    lines.push(`DTEND;VALUE=DATE:${endDateStr}`);
    lines.push(foldICSLine(`SUMMARY:${workout.emoji} ${escapeICS(workout.title)}${workout.isPlanned ? ' (Planned)' : ''}`));
    if (description) lines.push(foldICSLine(`DESCRIPTION:${escapeICS(description)}`));
    lines.push(workout.isPlanned ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function parseWorkoutDate(dateStr) {
  if (!dateStr) return null;
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }
  return null;
}

function formatICSDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatICSDateTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeICS(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function foldICSLine(line) {
  if (line.length <= 74) return line;

  const parts = [];
  let remaining = line;
  let first = true;

  while (remaining.length > 0) {
    const maxLen = first ? 74 : 73;
    parts.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
    first = false;
  }

  return parts.join('\r\n ');
}

// Routes
app.get('/:user.ics', async (req, res) => {
  const userKey = req.params.user;
  try {
    const data = await getWorkouts(userKey);
    res.type('text/calendar').send(formatAsICS(data));
  } catch (error) {
    res.status(error.message.includes('Unknown user') ? 404 : 500).type('text/plain').send('Error: ' + error.message);
  }
});

app.get('/:user.md', async (req, res) => {
  const userKey = req.params.user;
  try {
    const data = await getWorkouts(userKey);
    res.type('text/markdown').send(formatAsMarkdown(data));
  } catch (error) {
    res.status(error.message.includes('Unknown user') ? 404 : 500).send('# Error\n\n' + error.message);
  }
});

app.get('/:user', async (req, res) => {
  try {
    const data = await getWorkouts(req.params.user);
    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(error.message.includes('Unknown user') ? 404 : 500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  const users = Object.keys(USERS);
  const s = req.query.secret;
  res.send(`
    <h1>TrainingPeaks Workout API</h1>
    <h2>Available Users</h2>
    <ul>
      ${users.map(u => `
        <li><strong>${u}</strong>
          <ul>
            <li><a href="/${u}?secret=${s}">/${u}</a> - JSON</li>
            <li><a href="/${u}.md?secret=${s}">/${u}.md</a> - Markdown</li>
            <li><a href="/${u}.ics?secret=${s}">/${u}.ics</a> - ICS Calendar</li>
          </ul>
        </li>
      `).join('')}
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`TrainingPeaks API running at http://localhost:${PORT}`);
  console.log(`Available users: ${Object.keys(USERS).join(', ')}`);
});
