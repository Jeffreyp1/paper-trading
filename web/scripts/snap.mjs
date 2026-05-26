import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] || 'http://localhost:3001/';
const out = process.argv[3] || '/Users/jeffrey/paper-trading/design/iterations/iter.png';

await mkdir(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2000, height: 1470 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('saved', out);
