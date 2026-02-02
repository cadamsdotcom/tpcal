const { chromium } = require('playwright');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

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

/**
 * Fetches workouts from TrainingPeaks for a specific user
 */
async function fetchWorkoutsFromTrainingPeaks(userKey) {
  const user = USERS[userKey];
  if (!user) throw new Error(`Unknown user: ${userKey}`);

  console.log(`Fetching workouts for ${userKey}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Intercept API responses to get full workout data
    const apiWorkouts = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/workouts') || url.includes('/activities')) {
        try {
          const json = await response.json();
          if (Array.isArray(json)) {
            apiWorkouts.push(...json);
          } else if (json.workouts) {
            apiWorkouts.push(...json.workouts);
          }
        } catch (e) {}
      }
    });

    // Login
    await page.goto('https://home.trainingpeaks.com/login');
    await page.waitForSelector('input[name="Username"], input[type="email"]', { timeout: 15000 });

    await page.fill('input[name="Username"], input[type="email"]', user.username);
    await page.fill('input[name="Password"], input[type="password"]', user.password);
    await page.click('button[type="submit"]');

    // Wait for app to load
    await page.waitForURL('**/app.trainingpeaks.com/**', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Navigate to calendar to trigger API calls
    console.log('Navigating to calendar...');
    try {
      await page.click('text=Calendar', { timeout: 5000 });
      await page.waitForTimeout(4000);
    } catch (e) {
      await page.evaluate(() => { window.location.hash = '/calendar'; });
      await page.waitForTimeout(4000);
    }

    // Wait for API calls to complete
    await page.waitForTimeout(2000);
    console.log(`Intercepted ${apiWorkouts.length} workouts from API`);

    // Process API workouts into our format
    // First pass: collect all workouts, merging planned details into completed
    const seen = new Map();
    for (const api of apiWorkouts) {
      const date = api.workoutDay?.split('T')[0] || null;
      const title = api.title || 'Workout';
      const key = `${title}|${date}`;
      const isCompleted = api.totalTime && api.totalTime > 0;

      const existing = seen.get(key);

      // Merge: if we have a completed and planned version, combine them
      if (existing) {
        if (isCompleted && existing.isPlanned) {
          // Completed version - keep planned description, update with actual data
          existing.isPlanned = false;
          existing.duration = formatDurationHours(api.totalTime);
          existing.distance = api.distance ? formatDistance(api.distance) : existing.distance;
          existing.tss = api.tssActual ? `${Math.round(api.tssActual)} TSS` : existing.tss;
        } else if (!isCompleted && !existing.isPlanned) {
          // Planned version, but we already have completed - merge description and steps
          if (!existing.description && api.description) {
            existing.description = api.description;
          }
          if (!existing.steps && api.structure) {
            existing.steps = formatSteps(api.structure);
          }
        }
        continue;
      }

      seen.set(key, {
        title,
        date,
        duration: isCompleted ? formatDurationHours(api.totalTime) : formatDurationHours(api.totalTimePlanned),
        distance: formatDistance(api.distance || api.distancePlanned),
        tss: (api.tssActual || api.tssPlanned) ? `${Math.round(api.tssActual || api.tssPlanned)} TSS` : null,
        isPlanned: !isCompleted,
        description: api.description || api.coachComments || null,
        steps: formatSteps(api.structure)
      });
    }

    const workouts = Array.from(seen.values()).sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });

    console.log(`Processed ${workouts.length} unique workouts`);

    return {
      user: userKey,
      workouts,
      totalCount: workouts.length,
      plannedCount: workouts.filter(w => w.isPlanned).length,
      completedCount: workouts.filter(w => !w.isPlanned).length,
      fetchedAt: new Date().toISOString()
    };

  } finally {
    await browser.close();
  }
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

function formatSteps(structure) {
  if (!structure?.structure) return null;

  const steps = [];
  for (const block of structure.structure) {
    const reps = block.length?.unit === 'repetition' ? block.length.value : 1;
    const prefix = reps > 1 ? `${reps}x ` : '';

    for (const step of (block.steps || [])) {
      const name = step.name || step.intensityClass || 'Step';
      const len = step.length;
      let duration = '';
      if (len) {
        if (len.unit === 'meter') duration = `${len.value}m`;
        else if (len.unit === 'second') duration = `${len.value}s`;
        else if (len.unit === 'minute') duration = `${len.value}min`;
        else duration = `${len.value} ${len.unit}`;
      }
      const notes = step.notes ? ` - ${step.notes}` : '';
      steps.push(`${prefix}${name}${duration ? ` (${duration})` : ''}${notes}`);
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
      md += `### ${status} ${w.title}\n\n`;
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
    lines.push(foldICSLine(`SUMMARY:${escapeICS(workout.title)}${workout.isPlanned ? ' (Planned)' : ''}`));
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
