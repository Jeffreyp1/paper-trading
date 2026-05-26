import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:3001/';
const out = process.argv[3] || '/Users/jeffrey/paper-trading/design/iterations/portfolio-hover.png';
const xPct = parseFloat(process.argv[4] || '0.6');

await mkdir(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2000, height: 1470 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Find the chart's recharts surface, then hover at xPct of its width.
const chart = await page.locator('.recharts-surface').first();
const box = await chart.boundingBox();
if (!box) {
  console.error('no chart found');
  await browser.close();
  process.exit(1);
}
const x = box.x + box.width * xPct;
const y = box.y + box.height * 0.5;
await page.mouse.move(x, y);
await page.waitForTimeout(250);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('saved', out);
