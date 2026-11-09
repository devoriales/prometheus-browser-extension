// Installs (or removes) the native messaging host that connects the extension
// to the local Claude Code CLI.
//
//   npm run bridge:install                      # detect claude, install for every Chromium browser found
//   npm run bridge:install -- --extension-id ID # if you loaded the extension with a different ID
//   npm run bridge:install -- --claude-path /path/to/claude
//   npm run bridge:uninstall

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.promql_ai.claude_bridge";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Chrome derives an unpacked extension's ID from the "key" in its manifest. */
function extensionIdFromKey() {
  const key = readFileSync(join(root, "scripts/extension-public-key.txt"), "utf8").trim();
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hash].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

function browserDirs() {
  const home = homedir();
  if (platform() === "darwin") {
    const base = join(home, "Library/Application Support");
    return [
      ["Google Chrome", join(base, "Google/Chrome")],
      ["Chrome Beta", join(base, "Google/Chrome Beta")],
      ["Chromium", join(base, "Chromium")],
      ["Microsoft Edge", join(base, "Microsoft Edge")],
      ["Brave", join(base, "BraveSoftware/Brave-Browser")],
      ["Arc", join(base, "Arc/User Data")],
    ];
  }
  if (platform() === "linux") {
    const base = join(home, ".config");
    return [
      ["Google Chrome", join(base, "google-chrome")],
      ["Chromium", join(base, "chromium")],
      ["Microsoft Edge", join(base, "microsoft-edge")],
      ["Brave", join(base, "BraveSoftware/Brave-Browser")],
    ];
  }
  console.error("Automatic install supports macOS and Linux. On Windows, register the host manifest in the registry manually (see README).");
  process.exit(1);
}

function findClaude() {
  const explicit = flag("--claude-path");
  if (explicit) return resolve(explicit);
  const shell = process.env.SHELL || "/bin/sh";
  try {
    // Login shell so PATH matches what the user sees in a terminal.
    return execFileSync(shell, ["-lc", "command -v claude"], { encoding: "utf8" }).trim().split("\n").pop();
  } catch {
    for (const p of [join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) if (existsSync(p)) return p;
  }
  console.error("Could not find the `claude` CLI. Install Claude Code, or pass --claude-path /path/to/claude.");
  process.exit(1);
}

const targets = browserDirs().filter(([, dir]) => existsSync(dir));

if (args.includes("--uninstall")) {
  for (const [name, dir] of targets) {
    const file = join(dir, "NativeMessagingHosts", `${HOST_NAME}.json`);
    if (existsSync(file)) {
      rmSync(file);
      console.log(`Removed from ${name}`);
    }
  }
  process.exit(0);
}

const extensionId = flag("--extension-id") ?? extensionIdFromKey();
const claudePath = findClaude();
const version = execFileSync(claudePath, ["--version"], { encoding: "utf8" }).trim();

writeFileSync(join(here, "config.json"), JSON.stringify({ claudePath }, null, 2) + "\n");
const launcher = join(here, "run-host.sh");
writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "host.mjs")}" "$@"\n`);
chmodSync(launcher, 0o755);

const manifest = {
  name: HOST_NAME,
  description: "PromQL AI Assistant: bridge to the local Claude Code CLI",
  path: launcher,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

if (!targets.length) console.warn("No supported browser profile folder found.");
for (const [name, dir] of targets) {
  const hostDir = join(dir, "NativeMessagingHosts");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Installed for ${name}`);
}
console.log(`\nClaude Code: ${claudePath} (${version})\nExtension ID allowed: ${extensionId}`);
console.log("Make sure Claude Code is logged in with your subscription: run `claude`, then /login.");
