/**
 * End-to-end smoke test of the spec's user journeys, against a running stack
 * (frontend on :5173, API on :4000, AI service on :8000).
 *
 *   node e2e/smoke.mjs            # uses the `playwright` package
 *   BASE_URL=http://localhost:8080 node e2e/smoke.mjs
 *
 * Screenshots are written to e2e/screenshots/.
 */
// PLAYWRIGHT_MODULE lets you point at a globally installed copy.
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const chromium = pw.chromium ?? pw.default.chromium;
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/WebSocket|socket\.io|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

let step = 0;
async function check(name, fn) {
  step++;
  try {
    await fn();
    await page.screenshot({ path: `${OUT}${String(step).padStart(2, '0')}-${name}.png`, fullPage: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    await page.screenshot({ path: `${OUT}${String(step).padStart(2, '0')}-${name}-FAILED.png`, fullPage: true });
    console.error(`✗ ${name}: ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

try {
  // 1. Register and configure availability (onboarding).
  const email = `e2e${Date.now()}@example.com`;
  await check('landing', async () => {
    await page.goto(BASE);
    await page.getByRole('heading', { name: /Know what to work on next/ }).waitFor();
  });
  await check('register', async () => {
    await page.getByRole('link', { name: 'Get started' }).click();
    await page.getByLabel('Name').fill('E2E Tester');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Where are you working from?').waitFor();
  });
  await check('onboarding-hours', async () => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('When can you work?').waitFor();
    // Make every day fully available so the test is independent of the clock.
    for (const wd of ['Sat', 'Sun']) {
      const row = page.locator('div.flex', { has: page.locator(`span:text-is("${wd}")`) }).last();
      await row.getByRole('button', { name: '+ slot' }).click();
    }
    const starts = page.getByLabel(/start$/);
    const ends = page.getByLabel(/end$/);
    const n = await starts.count();
    for (let i = 0; i < n; i++) { await starts.nth(i).fill('00:00'); await ends.nth(i).fill('23:59'); }
    // Remove now-overlapping second weekday slots.
    while ((await page.getByRole('button', { name: 'Remove slot' }).count()) > 7) {
      const rows = page.locator('div.flex.flex-wrap.items-center.gap-2.px-3');
      for (let r = 0; r < (await rows.count()); r++) {
        const removes = rows.nth(r).getByRole('button', { name: 'Remove slot' });
        if ((await removes.count()) > 1) { await removes.last().click(); break; }
      }
    }
  });
  await check('onboarding-project', async () => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Project name').fill('Website launch');
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await page.getByText('Daily briefing').waitFor();
  });

  // 2. Create a project with dependent tasks.
  await check('project-tasks', async () => {
    await page.getByRole('link', { name: 'Projects' }).first().click();
    await page.getByRole('link', { name: /Website launch/ }).click();
    const add = async (title, minutes, deps = []) => {
      await page.getByRole('button', { name: 'Add task' }).click();
      const dlg = page.getByRole('dialog', { name: 'Add task' });
      await dlg.getByLabel('Title').fill(title);
      await dlg.getByLabel('Estimate (minutes)').fill(String(minutes));
      for (const d of deps) await dlg.getByLabel(d, { exact: true }).check();
      await dlg.getByRole('button', { name: 'Add task' }).click();
      await dlg.waitFor({ state: 'detached' });
    };
    await add('Design database schema', 180);
    await add('Build backend APIs', 360, ['Design database schema']);
    await add('Build frontend', 300, ['Build backend APIs']);
    await add('Integration testing', 180, ['Build backend APIs', 'Build frontend']);
    await add('Deployment', 60, ['Integration testing']);
    await page.getByRole('img', { name: /Timeline for Website launch/ }).waitFor();
  });

  // Cycle is rejected in the task panel.
  await check('cycle-rejected', async () => {
    await page.getByRole('button', { name: 'Design database schema' }).first().click();
    const panel = page.getByRole('dialog', { name: 'Task details' });
    await panel.getByLabel('Add prerequisite').selectOption({ label: 'Deployment' });
    await panel.getByText(/dependency cycle/i).waitFor();
    await panel.getByRole('button', { name: 'Close' }).click();
  });

  // AI extraction → drafts → confirm.
  await check('ai-extract', async () => {
    await page.getByRole('button', { name: /Add from text/ }).click();
    const dlg = page.getByRole('dialog', { name: 'Add tasks from text' });
    await dlg.locator('textarea').fill('Prepare the project demo by Friday. Finish API tests first, then create slides. I need around two hours for slides.');
    await dlg.getByRole('button', { name: 'Draft tasks' }).click();
    await dlg.getByText(/Review the drafts/).waitFor();
    await dlg.getByLabel('Estimate minutes').first().fill('90');
    await dlg.getByRole('button', { name: /Create 2 task/ }).click();
    await dlg.waitFor({ state: 'detached' });
  });

  // 3. Generate a schedule and accept it.
  await check('schedule-preview', async () => {
    await page.getByRole('link', { name: 'Smart planning' }).click();
    await page.getByRole('button', { name: 'Build my schedule' }).first().click();
    await page.getByText('Proposed blocks').waitFor();
  });
  await check('schedule-accepted', async () => {
    await page.getByRole('button', { name: 'Accept schedule' }).click();
    await page.getByText(/Schedule saved/).waitFor();
  });

  // 4. Calendar shows blocks; daily briefing.
  await check('calendar', async () => {
    await page.getByRole('link', { name: 'Calendar' }).click();
    await page.locator('.fc-event.block-event').first().waitFor({ timeout: 15000 });
  });
  await check('dashboard-briefing', async () => {
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await page.getByText('Start here').waitFor();
    await page.getByText('Top priorities').waitFor();
  });

  // 5. Report a delay → before/after preview → accept revised plan.
  await check('replan-preview', async () => {
    await page.getByRole('link', { name: 'Smart planning' }).click();
    await page.getByLabel('Task').selectOption({ label: 'Design database schema' });
    await page.getByRole('button', { name: 'Preview impact' }).click();
    await page.getByText(/Chain of affected work/).waitFor();
  });
  await check('replan-accepted', async () => {
    await page.getByRole('button', { name: 'Accept replan' }).click();
    await page.getByText(/Schedule saved/).waitFor();
  });

  await check('analytics', async () => {
    await page.getByRole('link', { name: 'Analytics' }).click();
    await page.getByText('Deadline feasibility').waitFor();
  });
  await check('project-timeline', async () => {
    await page.getByRole('link', { name: 'Projects' }).first().click();
    await page.getByRole('link', { name: /Website launch/ }).click();
    await page.getByRole('img', { name: /Timeline for Website launch/ }).waitFor();
  });

  // Mobile layout sanity.
  await check('mobile-dashboard', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: 'Dashboard' }).last().click();
    await page.getByText('Top priorities').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) throw new Error('horizontal page overflow at 390px');
  });
} finally {
  if (errors.length) {
    console.error('Browser errors:\n' + errors.join('\n'));
    process.exitCode = 1;
  }
  await browser.close();
}
