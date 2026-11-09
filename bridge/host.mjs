// Chrome native messaging host: lets the extension use the Claude Code CLI that
// is already logged in on this computer (Claude Pro/Max/Ultra subscription).
//
// Chrome starts this process once per message. It reads one length-prefixed
// JSON message from stdin, runs `claude -p` and writes one JSON reply.
// Claude runs with every tool disabled and in safe mode (no CLAUDE.md, hooks,
// plugins or MCP servers), so it can only return text. stdout carries the
// protocol, so all diagnostics go to stderr.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const WORK_DIR = join(homedir(), ".promql-claude-bridge");
const TIMEOUT_MS = 5 * 60_000;
const MAX_PROMPT = 4 * 1024 * 1024;

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    process.stdin.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      const buf = Buffer.concat(chunks, total);
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > MAX_PROMPT + 64 * 1024) return reject(new Error("Message too large"));
        if (buf.length >= 4 + len) resolve(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
      }
    });
    process.stdin.on("end", () => reject(new Error("stdin closed before a full message arrived")));
  });
}

function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function run(cmd, args, { input, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: WORK_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

function childEnv(forceSubscription) {
  const env = { ...process.env };
  // Chrome starts hosts with a minimal PATH; make sure claude (and node, for npm installs) resolve.
  env.PATH = [dirname(config.claudePath), dirname(process.execPath), env.PATH].filter(Boolean).join(":");
  if (forceSubscription) {
    // With these set, Claude Code bills the API instead of the logged-in subscription.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

const str = (v, re, name) => {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || (re && !re.test(v))) throw new Error(`Invalid ${name}`);
  return v;
};

async function handle(msg) {
  if (msg?.type === "ping") {
    const res = await run(config.claudePath, ["--version"], { env: childEnv(false) });
    return res.code === 0 ? { ok: true, version: `Claude Code ${res.stdout.trim()}` } : { ok: false, error: res.stderr.trim() || "claude --version failed" };
  }
  if (msg?.type !== "run") throw new Error("Unknown request");

  const prompt = str(msg.prompt, null, "prompt");
  const systemPrompt = str(msg.systemPrompt, null, "systemPrompt");
  if (!prompt || prompt.length > MAX_PROMPT || systemPrompt.length > MAX_PROMPT) throw new Error("Invalid prompt size");
  const model = str(msg.model, /^[\w.\-[\]]{1,80}$/, "model");
  const effort = str(msg.effort, /^(low|medium|high|xhigh|max)$/, "effort");
  const sessionId = str(msg.sessionId, /^[0-9a-f-]{36}$/i, "sessionId");
  const schema = JSON.stringify(msg.schema ?? {});

  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", schema,
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--system-prompt", systemPrompt,
  ];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (sessionId) args.push("--resume", sessionId);

  const res = await run(config.claudePath, args, { input: prompt, env: childEnv(msg.forceSubscription !== false) });
  let out;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: (res.stderr || res.stdout || `claude exited with code ${res.code}`).trim().slice(0, 2000) };
  }
  if (out.is_error) {
    return { ok: false, error: String(out.result || out.subtype || "Claude Code reported an error").slice(0, 2000), sessionId: out.session_id };
  }
  return { ok: true, sessionId: out.session_id, structured: out.structured_output ?? null, result: out.result ?? "", costUsd: out.total_cost_usd };
}

try {
  mkdirSync(WORK_DIR, { recursive: true });
  const msg = await readMessage();
  writeMessage(await handle(msg));
} catch (err) {
  process.stderr.write(`promql-claude-bridge: ${err?.stack ?? err}\n`);
  writeMessage({ ok: false, error: String(err?.message ?? err) });
}
process.exit(0);
