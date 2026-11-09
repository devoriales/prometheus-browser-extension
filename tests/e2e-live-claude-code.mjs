// Live test of the subscription path: extension → native host → local `claude -p`
// → real Claude, with tools executed against a real Prometheus.
// Registers the bridge only inside the temporary browser profile (Chromium reads
// <user-data-dir>/NativeMessagingHosts), so nothing outside the test changes.
import { chromium } from "playwright";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const QUESTION = process.argv[2] ?? "p90 latency of Prometheus HTTP requests per handler";
const extDir = mkdtempSync(join(tmpdir(), "promql-ai-ext-"));
cpSync("dist", extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions.push("http://localhost/*");
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

const profile = mkdtempSync(join(tmpdir(), "promql-ai-profile-"));
const launcher = join(profile, "run-host.sh");
writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${join(process.cwd(), "bridge/host.mjs")}" "$@"\n`);
chmodSync(launcher, 0o755);
mkdirSync(join(profile, "NativeMessagingHosts"));
writeFileSync(
  join(profile, "NativeMessagingHosts/com.promql_ai.claude_bridge.json"),
  JSON.stringify({ name: "com.promql_ai.claude_bridge", description: "test", path: launcher, type: "stdio", allowed_origins: ["chrome-extension://mfnlldhpoaebjhmoeinjkdmidpcafolm/"] }),
);

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 1400, height: 900 },
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const mode = process.env.MODE ?? "concise";
await sw.evaluate(async (mode) => {
  await chrome.storage.sync.set({
    settings: {
      provider: "claude-code", claudeCodeModel: "haiku", effort: "low", responseMode: mode,
      instances: [{ id: "v3", name: "Prom v3", baseUrl: "http://localhost:19090/", headers: "", notes: "" }],
    },
  });
}, mode);
const ping = await sw.evaluate(() => new Promise((r) => chrome.runtime.sendNativeMessage("com.promql_ai.claude_bridge", { type: "ping" }, (res) => r(res ?? chrome.runtime.lastError?.message))));
console.log("bridge ping from extension:", JSON.stringify(ping));

const page = await context.newPage();
await page.goto("http://localhost:19090/query");
await page.waitForSelector(".cm-content");
await page.locator("promql-ai-panel .fab").click();
await page.locator("promql-ai-panel textarea").fill(QUESTION);
const t0 = Date.now();
await page.locator("promql-ai-panel textarea").press("Control+Enter");
await page.locator("promql-ai-panel .answer, promql-ai-panel .error").first().waitFor({ timeout: 240000 });
await page.locator("promql-ai-panel .badge:not(.pending):not(.hidden)").waitFor({ timeout: 30000 }).catch(() => {});
console.log(`answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("steps:", (await page.locator("promql-ai-panel .progress .step").allTextContents()).join(" → "));
console.log("error:", await page.locator("promql-ai-panel .error").allTextContents());
console.log("query:", await page.locator("promql-ai-panel .answer pre.query").allTextContents());
console.log("text:", await page.locator("promql-ai-panel .answer .text").allTextContents());
console.log("badge:", await page.locator("promql-ai-panel .badge summary").allTextContents());
await page.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "live.png") });
await context.close();
