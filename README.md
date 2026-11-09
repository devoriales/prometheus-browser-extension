# PromQL Assistant for Claude

A Chrome extension that adds an **Ask Claude** panel to the Prometheus web UI. Describe the query you need ("p95 latency per route", "which pods restart most?"). Claude then:

1. looks up the metrics and labels that actually exist on *your* server,
2. writes the PromQL and test-runs it against Prometheus,
3. gives you the query with a short explanation and a ✓/⚠/✗ check, and
4. inserts it into the editor and runs it with one click.

It also fixes and explains the query that's already in the editor, and it remembers the conversation, so you can follow up with "now only for namespace X".

Works with the Prometheus v3 UI (`/query`), the v2 UI (`/graph`), and anything that serves the Prometheus HTTP API under a base URL (Thanos, Mimir, Cortex, VictoriaMetrics…).

## Install

```bash
npm install
npm run build
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `dist/` folder.
2. Click the extension's toolbar icon (or open its **Options**). Choose how to connect to Claude and add your Prometheus servers. Click **Save** and allow access to those hosts when Chrome asks.
3. Reload your Prometheus tab. The **✦ Ask Claude** button is in the bottom-right corner. **Alt+Shift+P** toggles it.

Tip: if you click the toolbar icon on a Prometheus page you haven't added yet, the options page opens with that server filled in.

## Connecting to Claude: three options

| Option | Use it when | Billing |
|---|---|---|
| **Anthropic API key** | You have a key from the Claude Developer Platform | Per token on your API account |
| **API gateway / proxy (token)** | Your company routes LLM traffic through a gateway (LiteLLM, an internal proxy, a Bedrock/Vertex gateway) | Whatever the gateway bills |
| **Claude subscription via Claude Code** | You have Claude Pro / Max / Ultra and Claude Code installed | Counts toward your plan's usage limits |

### API key and gateway tokens

Paste the key or token in the options page. The gateway option accepts any base URL that speaks the Claude Messages API (`<base>/v1/messages`), with `Authorization: Bearer`, `x-api-key`, or no auth header, plus any extra headers you need. Secrets are kept in `chrome.storage.local` (this browser only, never synced). Other settings sync through your Chrome profile.

With an Anthropic API key, the extension turns on server-side refusal fallback: if a request is declined, Anthropic re-runs it on its recommended fallback model. You can turn this off.

### Claude subscription (Pro / Max / Ultra)

A browser extension can't sign in with your subscription directly, because Anthropic only supports subscription use through Claude Code itself. So the extension talks to the `claude` CLI already logged in on your computer, through a small local bridge (a Chrome *native messaging host*):

```bash
claude            # once: run /login and sign in with your subscription
npm run bridge:install
```

This finds your `claude` binary and registers the bridge for Chrome, Chromium, Edge, Brave and Arc (whichever are installed, on macOS and Linux). The bridge allows only this extension's ID, which is fixed by the `key` in `static/manifest.json`. If you load the extension under a different ID, pass `--extension-id <id>`. To remove the bridge, run `npm run bridge:uninstall`.

How the bridge keeps things contained (`bridge/host.mjs`):

- It runs `claude -p` with **every tool disabled** (`--tools ""`), so Claude can only return text.
- It uses `--safe-mode` and `--strict-mcp-config`, so your CLAUDE.md files, hooks, plugins and MCP servers aren't loaded.
- It runs in its own folder, `~/.promql-claude-bridge`, and validates every field of each request.
- By default it removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment. If either is set, Claude Code bills the API instead of your plan ([details](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan)). Untick **Always bill my subscription** if you want the API key used.

Claude Code print mode has no browser-side tools, so this engine uses a JSON action protocol instead (`--json-schema`). Each lookup is one `claude -p --resume <session>` call, which takes about 3 seconds per step.

## Configuration

Everything is on the options page:

- **Prometheus servers.** Each server has a base URL (include any route prefix, e.g. `https://example.com/prometheus/`), optional extra API headers (e.g. `X-Scope-OrgID: tenant-a` for Mimir/Cortex), and notes for Claude ("services are identified by the `app` label"). Requests use your existing browser session, so SSO and cookie auth work.
- **Model and effort.** The default is `claude-opus-5-5` at medium effort. `claude-sonnet-5-5` and `claude-haiku-5-5` are faster and cheaper. For the subscription you can pick a Claude Code model alias (`opus`, `sonnet`, `haiku`).
- **Query checking.** *Run as instant query* (default, most accurate, and it catches empty results), *Syntax check only* (uses `/api/v1/format_query` and never executes), or *Off*.
- **Metric list size.** If the server has at most N metrics (default 1500), the full name/type list goes into the cached system prompt. Above that, Claude searches.
- **Team instructions.** These are added to every request, e.g. "always filter by `cluster`" or "use our `job:` recording rules".
- **Insert mode.** By default the query is edited in place through CodeMirror's API, which keeps undo history. If that fails, the extension simulates typing, and if that fails too, it reloads the page with `?g0.expr=`.

## How it works

```
Prometheus page (content script)              Service worker                     Claude
┌─────────────────────────────┐   Port   ┌───────────────────────┐
│ panel UI (shadow DOM)       │◄────────►│ ChatSession tool loop │──► Messages API (key / gateway)
│ tools → Prometheus HTTP API │ toolCall │  AnthropicEngine      │
│ (same origin, your session) │ toolResult│  ClaudeCodeEngine ────┼──► native host ─► claude -p
│ editor insert / execute     │          └───────────────────────┘
└─────────────────────────────┘
```

- **Tools** (`src/shared/prompt.ts`): `search_metrics`, `get_metric_labels`, `run_query`, `submit_query`. They run in the page, so they reach Prometheus exactly as you do.
- **Prompt caching.** The instructions and the per-server metric list form a stable, cached prefix. The editor contents and your question go in the user turn. Conversation history is append-only.
- **Privacy.** What leaves your browser: your questions, the query in the editor (you can untick this per question), metric names and types, and the label values and query results returned by the tools. Check that this is acceptable for your data before using a third-party API.

## Development

```bash
npm run watch        # rebuild dist/ on change (then click reload in chrome://extensions)
npm run typecheck
npm test             # unit tests
```

End-to-end tests run real Chromium with the extension against real Prometheus v3 and v2 containers:

```bash
docker run -d --name promql-ai-v3 -p 19090:9090 prom/prometheus:v3.5.0
docker run -d --name promql-ai-v2 -p 19091:9090 prom/prometheus:v2.55.1
npx playwright install chromium
npm run build
node tests/e2e.mjs                    # scripted mock of the Messages API (no key needed)
node tests/e2e-live-claude-code.mjs   # live: your Claude Code subscription (uses a little of your plan)
```

`tests/e2e.mjs` checks the whole flow: the panel, real tool calls, the request shape (auth headers, cache breakpoints, strict tools, append-only history), the validation badge, and inserting and executing the query on both UIs.

## Limitations

- Chrome/Chromium-based browsers only (Manifest V3). The bridge installer supports macOS and Linux; on Windows, register `bridge/run-host.sh`'s equivalent in the registry yourself.
- Inserting targets the last-focused expression editor, or the first one on the page.
- Answers are generated by an AI model. They're checked against your server, but read a query before you build alerts on it.
# prometheus-browser-extension
