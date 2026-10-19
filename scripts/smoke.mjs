// Browser smoke test for a built app: `node scripts/smoke.mjs <base-url>`.
// Runs in CI against the production build before deploying, and against the live
// site after deploying. The dev server does not bundle code, so bundling bugs only
// show up here (one blanked production on 2026-10-19).
import { chromium } from 'playwright';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: node scripts/smoke.mjs <base-url>');
  process.exit(2);
}

const problems = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => problems.push(`Page error: ${err.message}`));
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`Console error: ${msg.text()}`));
  page.on('requestfailed', (req) => problems.push(`Request failed: ${req.url()} (${req.failure()?.errorText})`));
  page.on('response', (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));

  // 1. API and database are up.
  const health = await page.request.get(`${base}/api/health`);
  const body = await health.json().catch(() => null);
  if (!health.ok() || body?.status !== 'ok' || body?.db !== 'up') {
    problems.push(`Health check failed: HTTP ${health.status()} ${JSON.stringify(body)}`);
  }

  // 2. The app renders: a logged-out visitor lands on the login form.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 15_000 });
  await page.locator('input[autocomplete="current-password"]').waitFor({ timeout: 15_000 });

  // 3. Deep links work (nginx falls back to index.html) and keep the target for after login.
  await page.goto(`${base}/settings/users`, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="current-password"]').waitFor({ timeout: 15_000 });
  if (!page.url().includes('next=%2Fsettings%2Fusers')) problems.push(`Deep link lost its target: ${page.url()}`);
} catch (err) {
  problems.push(`Check failed: ${err.message}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`Smoke test FAILED for ${base}:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Smoke test passed for ${base}`);
