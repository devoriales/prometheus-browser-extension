// End-to-end test: real Chromium + the built extension + real Prometheus
// (v3 and v2 UIs in Docker) + a scripted mock of the Claude Messages API, used
// through the "gateway" provider. It checks the whole flow: panel → tool calls
// against Prometheus → answer → validation badge → insert & run in the editor.
//
//   docker run -d --name promql-ai-v3 -p 19090:9090 prom/prometheus:v3.5.0
//   docker run -d --name promql-ai-v2 -p 19091:9090 prom/prometheus:v2.55.1
//   npm run build && node tests/e2e.mjs

import { chromium } from "playwright";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const MOCK_PORT = 18787;
const FINAL_QUERY = 'sum by (handler) (rate(prometheus_http_requests_total{code="200"}[5m]))';
const SHOTS = process.env.SHOTS_DIR ?? mkdtempSync(join(tmpdir(), "promql-ai-shots-"));

// ---- mock Claude Messages API -------------------------------------------------
const requests = [];
const script = [
  { name: "search_metrics", input: { pattern: "http_requests" } },
  { name: "get_metric_labels", input: { metric: "prometheus_http_requests_total" } },
  { name: "run_query", input: { query: FINAL_QUERY } },
  { name: "submit_query", input: { query: FINAL_QUERY, explanation: "Per-second rate of **successful** requests, summed per `handler`." } },
];

const mock = createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body: json });
    // Each user turn after the first carries one tool_result; step = number of assistant turns so far.
    const step = json.messages.filter((m) => m.role === "assistant").length % script.length;
    const call = script[step];
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: json.model,
        content: [{ type: "tool_use", id: `toolu_${requests.length}`, name: call.name, input: call.input }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

// ---- extension build with localhost pre-granted (tests can't click permission prompts)
const extDir = mkdtempSync(join(tmpdir(), "promql-ai-ext-"));
cpSync("dist", extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
writeFileSync(join(extDir, "manifest.json"), JSON.stringify(manifest));

const context = await chromium.launchPersistentContext("", {
  channel: "chromium",
  headless: process.env.HEADED ? false : true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  viewport: { width: 1400, height: 900 },
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const extensionId = sw.url().split("/")[2];
console.log("extension id:", extensionId);

await sw.evaluate(async (port) => {
  await chrome.storage.local.set({ secrets: { anthropicApiKey: "", gatewayToken: "test-token" } });
  const base = (await chrome.storage.sync.get("settings")).settings ?? {};
  await chrome.storage.sync.set({
    settings: {
      ...base,
      provider: "gateway",
      gatewayBaseUrl: `http://127.0.0.1:${port}`,
      gatewayAuth: "bearer",
      gatewayHeaders: "X-Team: observability",
      model: "claude-opus-5-5",
      instances: [
        { id: "v3", name: "Prom v3", baseUrl: "http://localhost:19090/", headers: "", notes: "Self-scraping test server." },
        { id: "v2", name: "Prom v2", baseUrl: "http://localhost:19091/", headers: "", notes: "" },
      ],
    },
  });
}, MOCK_PORT);
await new Promise((r) => setTimeout(r, 1000)); // storage.onChanged → registerContentScripts

async function runFlow(url, label, mode) {
  const before = requests.length;
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  await page.goto(url);
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.locator("promql-ai-panel .fab").click();
  await page.locator(`promql-ai-panel [data-mode=${mode}]`).click();
  assert.equal(await page.locator(`promql-ai-panel [data-mode=${mode}]`).getAttribute("aria-pressed"), "true");
  await page.locator("promql-ai-panel textarea").fill("Request rate per handler for successful requests");
  await page.locator("promql-ai-panel textarea").press("Control+Enter");
  await page.locator("promql-ai-panel .answer pre.query").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("promql-ai-panel .answer pre.query").textContent(), FINAL_QUERY);
  await page.locator("promql-ai-panel .badge.ok").waitFor({ timeout: 15000 });
  const badge = await page.locator("promql-ai-panel .badge").textContent();
  const steps = await page.locator("promql-ai-panel .progress .step").allTextContents();
  await page.screenshot({ path: join(SHOTS, `${label}-answer.png`) });

  await page.locator("promql-ai-panel .answer .btn.primary").click();
  await page.waitForFunction(
    (q) => [...document.querySelectorAll(".cm-content .cm-line")].map((l) => l.textContent).join("\n") === q,
    FINAL_QUERY,
    { timeout: 10000 },
  );
  // The query ran: a handler label value shows up in Prometheus' own result table
  // (document.body.innerText does not include our shadow DOM panel).
  await page.waitForFunction(() => document.body.innerText.includes("/api/v1/query"), null, { timeout: 15000 });
  await page.screenshot({ path: join(SHOTS, `${label}-inserted.png`) });

  const mine = requests.slice(before);
  console.log(`[${label}] ${mine.length} API calls; steps: ${steps.join(" → ")}; badge: ${badge}`);
  await page.close();
  return mine;
}

let failed = false;
try {
  const v3 = await runFlow("http://localhost:19090/query", "v3", "educational");
  // Request shape checks on the first conversation.
  const first = v3[0];
  assert.equal(first.url, "/v1/messages");
  assert.equal(first.headers.authorization, "Bearer test-token");
  assert.equal(first.headers["x-team"], "observability");
  assert.equal(first.headers["x-api-key"], undefined);
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.fallbacks, undefined, "no server-side fallback through a gateway");
  assert.deepEqual(first.body.output_config, { effort: "medium" });
  assert.equal(first.body.system[1].cache_control.type, "ephemeral");
  assert.match(first.body.system[1].text, /prometheus_http_requests_total counter/);
  assert.ok(first.body.tools.every((t) => t.strict === true));
  assert.deepEqual(first.body.tools.map((t) => t.name), ["search_metrics", "get_metric_labels", "run_query", "submit_query"]);
  // Tool results contain real Prometheus data.
  const toolResult = (req) => req.body.messages.at(-1).content.find((b) => b.type === "tool_result").content;
  assert.match(toolResult(v3[1]), /prometheus_http_requests_total \| counter/);
  assert.match(toolResult(v3[2]), /handler: .*"\/api\/v1\/query"/);
  assert.match(toolResult(v3[3]), /^OK\. vector with \d+ series/);
  // History is append-only: assistant turns are replayed unchanged.
  assert.equal(v3[3].body.messages.length, 7);

  const v2 = await runFlow("http://localhost:19091/graph", "v2", "concise");
  const firstText = (req) => req.body.messages[0].content.find((b) => b.type === "text").text;
  assert.match(firstText(v3[0]), /Response style: educational/);
  assert.match(firstText(v2[0]), /Response style: concise/);
  assert.doesNotMatch(JSON.stringify(v3[0].body.system), /Response style:/, "style stays out of the cached system prompt");
  console.log("\nE2E PASSED. Screenshots in", SHOTS);
} catch (err) {
  failed = true;
  console.error("\nE2E FAILED:", err);
  for (const p of context.pages()) await p.screenshot({ path: join(SHOTS, `failure-${Date.now()}.png`) }).catch(() => {});
  console.error("Screenshots in", SHOTS);
} finally {
  await context.close();
  mock.close();
}
process.exit(failed ? 1 : 0);
