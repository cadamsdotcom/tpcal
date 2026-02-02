const { chromium } = require('playwright');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Load users from environment variables
// Format: TP_<USER>_USERNAME and TP_<USER>_PASSWORD
function loadUsersFromEnv() {
  const users = {};
  const envKeys = Object.keys(process.env);

  // Find all TP_*_USERNAME entries
  const userKeys = envKeys
    .filter(k => k.startsWith('TP_') && k.endsWith('_USERNAME'))
    .map(k => k.slice(3, -9).toLowerCase()); // Extract user key

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
  console.error('Example: TP_CHRIS_USERNAME=myuser TP_CHRIS_PASSWORD=mypass');
  process.exit(1);
}

// Per-user cache
const cache = {};
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours (once per day)

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
    // Login
    await page.goto('https://home.trainingpeaks.com/login');
    await page.waitForSelector('input[name="Username"], input[type="email"]', { timeout: 15000 });

    await page.fill('input[name="Username"], input[type="email"]', user.username);
    await page.fill('input[name="Password"], input[type="password"]', user.password);
    await page.click('button[type="submit"]');

    // Wait for app to load
    await page.waitForURL('**/app.trainingpeaks.com/**', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Navigate to calendar
    console.log('Navigating to calendar...');
    try {
      await page.click('text=Calendar', { timeout: 5000 });
      await page.waitForTimeout(4000);
    } catch (e) {
      await page.evaluate(() => { window.location.hash = '/calendar'; });
      await page.waitForTimeout(4000);
    }

    // Save debug screenshot
    await page.screenshot({ path: `debug-${userKey}.png`, fullPage: true });

    // Extract workout data with dates using DOM structure
    const data = await page.evaluate(() => {
      const workouts = [];

      // Get current month/year from the page header
      const monthYearEl = document.querySelector('[class*="month"], h1, h2');
      const monthYearText = monthYearEl?.textContent || '';
      const monthMatch = monthYearText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
      const currentMonth = monthMatch ? monthMatch[1] : new Date().toLocaleString('en', { month: 'long' });
      const currentYear = monthMatch ? monthMatch[2] : new Date().getFullYear();

      // Find workout cards/items in the DOM
      const workoutElements = document.querySelectorAll('[class*="workout"], [class*="Workout"], [class*="activity"], [class*="Activity"]');

      workoutElements.forEach(el => {
        // Try to get title
        const titleEl = el.querySelector('[class*="title"], [class*="Title"], [class*="name"], h3, h4, strong') || el;
        let title = titleEl?.textContent?.trim() || '';
        title = title.split('\n')[0].trim();

        if (!title || title.length < 2 || title.length > 100) return;
        if (title.match(/^(Metrics|Sleep|HRV|Time in|Body Battery|Stress|Resting|Performance|Upgrade|Sample)/i)) return;

        // Try to find date from parent elements
        let date = null;
        let parent = el.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          if (parent.dataset?.date) {
            date = parent.dataset.date;
            break;
          }
          if (parent.textContent?.includes('Today') && parent.textContent.length < 50) {
            const dayMatch = parent.textContent.match(/Today\s*(\d{1,2})?/);
            if (dayMatch && dayMatch[1]) {
              date = `${currentMonth} ${dayMatch[1]}, ${currentYear}`;
            } else {
              date = 'Today';
            }
            break;
          }
          const dayNumMatch = parent.textContent?.match(/^(\d{1,2})\s/);
          if (dayNumMatch) {
            date = `${currentMonth} ${dayNumMatch[1]}, ${currentYear}`;
            break;
          }
          parent = parent.parentElement;
        }

        // Get duration
        const durationMatch = el.textContent.match(/(\d{1,2}:\d{2}:\d{2})/);
        const duration = durationMatch ? durationMatch[1] : null;
        const isPlanned = el.textContent.includes('--:--:--') || !duration;

        // Get distance
        const distanceMatch = el.textContent.match(/(\d+\.?\d*)\s*(km|m|mi)/i);
        const distance = distanceMatch ? `${distanceMatch[1]} ${distanceMatch[2]}` : null;

        // Get TSS
        const tssMatch = el.textContent.match(/(\d+)\s*TSS/i);
        const tss = tssMatch ? `${tssMatch[1]} TSS` : null;

        // Get description
        let description = null;
        const descEl = el.querySelector('[class*="description"], [class*="Description"]');
        if (descEl) {
          description = descEl.textContent?.trim();
        }

        workouts.push({
          title,
          date,
          duration,
          distance,
          tss,
          description,
          isPlanned,
          details: []
        });
      });

      // Fallback: parse raw text if DOM method didn't find much
      if (workouts.length < 3) {
        const bodyText = document.body.innerText;
        const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l);

        let currentDate = null;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          if (line.match(/^Today\s*\d*/)) {
            const dayNum = line.match(/\d+/);
            currentDate = dayNum ? `${currentMonth} ${dayNum[0]}, ${currentYear}` : 'Today';
            continue;
          }

          if (/^\d{1,2}$/.test(line) && parseInt(line) >= 1 && parseInt(line) <= 31) {
            currentDate = `${currentMonth} ${line}, ${currentYear}`;
            continue;
          }

          const durationMatch = line.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
          if (durationMatch && i > 0) {
            const title = lines[i - 1];
            if (title && !title.match(/^(Home|Calendar|Dashboard|Metrics|Sleep)/i) && title.length > 2) {
              workouts.push({
                title,
                date: currentDate,
                duration: line,
                isPlanned: false,
                distance: null,
                tss: null,
                description: null,
                details: []
              });
            }
          }
        }
      }

      return {
        workouts,
        rawText: document.body.innerText,
        url: window.location.href
      };
    });

    // Dedupe workouts
    const seen = new Set();
    const uniqueWorkouts = data.workouts.filter(w => {
      const key = `${w.title}|${w.date}|${w.duration}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      user: userKey,
      workouts: uniqueWorkouts,
      totalCount: uniqueWorkouts.length,
      plannedCount: uniqueWorkouts.filter(w => w.isPlanned).length,
      completedCount: uniqueWorkouts.filter(w => !w.isPlanned && w.duration).length,
      fetchedAt: new Date().toISOString()
    };

  } finally {
    await browser.close();
  }
}

/**
 * Get workouts with per-user caching
 */
async function getWorkouts(userKey) {
  if (!USERS[userKey]) throw new Error(`Unknown user: ${userKey}`);

  const now = Date.now();

  // Check user-specific cache
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
  let md = `# TrainingPeaks Workouts - ${data.user}\n\n`;
  md += `_Last updated: ${data.fetchedAt}_\n`;
  md += `_Total: ${data.totalCount} workouts (${data.plannedCount} planned, ${data.completedCount} completed)_\n\n`;

  const byDate = {};
  data.workouts.forEach(w => {
    const date = w.date || 'No Date';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(w);
  });

  for (const [date, workouts] of Object.entries(byDate)) {
    md += `## ${date}\n\n`;
    workouts.forEach(w => {
      const status = w.isPlanned ? '⏳' : '✅';
      md += `### ${status} ${w.title}\n\n`;
      if (w.duration) md += `- **Duration:** ${w.duration}\n`;
      if (w.distance) md += `- **Distance:** ${w.distance}\n`;
      if (w.tss) md += `- **TSS:** ${w.tss}\n`;
      if (w.description) md += `\n${w.description}\n`;
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
    `X-WR-CALNAME:TrainingPeaks - ${data.user}`,
    'X-WR-TIMEZONE:Australia/Melbourne'
  ];

  data.workouts.forEach((workout, index) => {
    let eventDate = parseWorkoutDate(workout.date);
    if (!eventDate) eventDate = new Date();

    const uid = `workout-${data.user}-${index}-${eventDate.getTime()}@trainingpeaks`;
    const dateStr = formatICSDate(eventDate);

    let description = '';
    if (workout.duration) description += `Duration: ${workout.duration}\\n`;
    if (workout.distance) description += `Distance: ${workout.distance}\\n`;
    if (workout.tss) description += `TSS: ${workout.tss}\\n`;
    if (workout.description) description += `\\n${workout.description}`;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${formatICSDateTime(new Date())}`);
    lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
    lines.push(`DTEND;VALUE=DATE:${dateStr}`);
    lines.push(`SUMMARY:${escapeICS(workout.title)}${workout.isPlanned ? ' (Planned)' : ''}`);
    if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
    lines.push(workout.isPlanned ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function parseWorkoutDate(dateStr) {
  if (!dateStr) return null;
  const now = new Date();
  const year = now.getFullYear();

  if (dateStr.toLowerCase() === 'today') return now;
  if (dateStr.toLowerCase() === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  // Handle "Month Day, Year" format
  const fullMatch = dateStr.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (fullMatch) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const monthIndex = monthNames.indexOf(fullMatch[1].toLowerCase());
    const day = parseInt(fullMatch[2]);
    const yr = fullMatch[3] ? parseInt(fullMatch[3]) : year;
    return new Date(yr, monthIndex, day);
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

// Routes - order matters: most specific first
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
  res.send(`
    <h1>TrainingPeaks Workout API</h1>
    <h2>Available Users</h2>
    <ul>
      ${users.map(u => `
        <li><strong>${u}</strong>
          <ul>
            <li><a href="/${u}">/${u}</a> - JSON</li>
            <li><a href="/${u}.md">/${u}.md</a> - Markdown</li>
            <li><a href="/${u}.ics">/${u}.ics</a> - ICS Calendar</li>
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
