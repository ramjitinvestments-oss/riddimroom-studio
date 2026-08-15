// Manual export-engine smoke test (see PROGRESS.md "Export engine
// verification"). Not part of `npm run lint`/`npm run build` — Playwright
// is not a project dependency (adding it would force a browser download on
// every future `npm install`). To run this:
//   npm install --no-save playwright && npx playwright install chromium
//   npx esbuild test-export-browser/harness.ts --bundle --format=iife --platform=browser --outfile=test-export-browser/harness.bundle.js
//   (npx serve test-export-browser -p 8999  # or any static server)
//   node test-export-browser/run.mjs
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => logs.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto('http://localhost:8999/index.html');
  await page.waitForFunction(() => (window).__EXPORT_TEST_RESULT__ !== undefined, { timeout: 30000 });
  const result = await page.evaluate(() => (window).__EXPORT_TEST_RESULT__);

  console.log(JSON.stringify(result, null, 2));
  console.log('\n--- browser console ---');
  logs.forEach((l) => console.log(l));

  await browser.close();

  const checks = result.checks || [];
  const failed = checks.filter((c) => !c.pass);
  if (result.crashed) {
    console.error(`\nHARNESS CRASHED: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
