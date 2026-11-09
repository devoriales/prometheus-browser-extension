// Renders scripts/icon.svg to the PNG sizes Chrome needs (static/icons/icon-<n>.png).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `static/icons/icon-${size}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written");
