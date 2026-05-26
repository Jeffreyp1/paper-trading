import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2];
const out = process.argv[3];
const selector = process.argv[4];
await mkdir(path.dirname(out), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2000, height: 1470 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const el = await page.locator(selector).first();
await el.screenshot({ path: out });
await browser.close();
console.log('saved', out);
