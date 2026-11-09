// The in-page chat panel. Rendered inside a shadow root so Prometheus' styles
// and ours don't interfere. Colours follow the devoriales.com palette.

import { pageColorScheme } from "./editor";
import { renderMarkdown } from "../shared/markdown";
import type { ResponseMode } from "../shared/settings";

export interface PanelHandlers {
  onAsk(text: string, includeEditorQuery: boolean): void;
  onReset(): void;
  onInsert(query: string, run: boolean): void;
  onOpenSettings(): void;
  onModeChange(mode: ResponseMode): void;
}

export type Badge = { kind: "ok" | "warn" | "error" | "pending"; text: string; detail?: string };

// Small inline icons (24×24 stroke icons drawn in currentColor).
const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  sparkle: svg('<path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z"/><path d="M19 3v4M17 5h4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  bolt: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>', 13),
  book: svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>', 13),
  play: svg('<path d="M7 4l13 8-13 8z"/>', 13),
  insert: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>', 13),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 13),
  // devoriales "code window" mark
  devoriales: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M10 11.5l-2.2 2.5 2.2 2.5M14 11.5l2.2 2.5-2.2 2.5M12.7 11l-1.4 6"/>', 13),
};

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
/* devoriales.com palette: crimson brand (#f52549) with the site's neutral greys, light and dark */
.root { --bg:#ffffff; --surface:#fafafa; --fg:#333333; --heading:#444444; --muted:#6c757d; --border:#dddddd;
  --brand:#f52549; --brand-strong:#d81e3f; --brand-fg:#ffffff; --brand-soft:#fde9ed;
  --code:#f5f5f5; --ok:#1e7e34; --warn:#9a6700; --err:#c82333;
  font: 13px/1.5 Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
.root.dark { --bg:#1a1a1a; --surface:#2d2d2d; --fg:#e0e0e0; --heading:#f0f0f0; --muted:#aaaaaa; --border:#404040;
  --brand-strong:#e0213f; --brand-soft:#3a2328; --code:#2d2d2d; --ok:#3ddc84; --warn:#d29922; --err:#ff6b6b; }
svg { display: block; flex: none; }
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; border: none; border-radius: 999px;
  background: var(--brand-strong); color: var(--brand-fg); padding: 9px 16px 9px 13px; font: inherit; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 7px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.fab:hover { background: var(--brand); }
.panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: min(460px, calc(100vw - 40px));
  height: min(660px, calc(100vh - 40px)); display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
  border: 1px solid var(--border); border-top: 3px solid var(--brand); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden; }
.hidden { display: none !important; }
header { display: flex; align-items: center; gap: 4px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
header h1 { font-size: 14px; margin: 0; flex: 1; color: var(--heading); display: flex; align-items: center; gap: 7px; }
header h1 .mark { color: var(--brand); }
.icon { background: none; border: 1px solid transparent; color: var(--muted); border-radius: 6px; padding: 5px; cursor: pointer; display: flex; }
.icon:hover { border-color: var(--border); color: var(--fg); }
.modes { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border); }
.modes .label { color: var(--muted); font-size: 12px; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 2px; background: var(--surface); }
.seg button { border: none; background: none; color: var(--muted); font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px;
  cursor: pointer; display: flex; align-items: center; gap: 5px; }
.seg button:hover { color: var(--fg); }
.seg button[aria-pressed=true] { background: var(--brand-strong); color: var(--brand-fg); }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.empty { color: var(--muted); }
.empty ul { padding-left: 18px; margin: 6px 0; }
.empty li { cursor: pointer; margin: 3px 0; }
.empty li:hover { color: var(--brand); }
.msg-user { align-self: flex-end; background: var(--brand-soft); padding: 8px 10px; border-radius: 10px; max-width: 90%; white-space: pre-wrap; word-break: break-word; }
.progress { color: var(--muted); font-size: 12px; }
.progress .step { display: block; }
.progress .step:last-child::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%;
  background: var(--brand); animation: pulse 1s infinite alternate; }
.progress.done .step:last-child::before { display: none; }
@keyframes pulse { from { opacity: .3 } to { opacity: 1 } }
.answer { border: 1px solid var(--border); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.answer .text { word-break: break-word; }
.answer .text p { margin: 0 0 6px; }
.answer .text ul { margin: 0 0 6px; padding-left: 18px; }
.answer .text li { margin: 2px 0; }
.answer .text strong { color: var(--heading); }
pre, code { font-family: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--code); border-radius: 4px; }
code { padding: 1px 4px; }
pre { padding: 8px; margin: 0; white-space: pre-wrap; word-break: break-word; }
.query { border-left: 3px solid var(--brand); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.btn { border: 1px solid var(--border); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit;
  display: inline-flex; align-items: center; gap: 5px; }
.btn:hover { border-color: var(--brand); }
.btn.primary { background: var(--brand-strong); color: var(--brand-fg); border-color: var(--brand-strong); }
.btn.primary:hover { background: var(--brand); border-color: var(--brand); }
.btn:disabled { opacity: .6; cursor: default; }
.badge { font-size: 12px; }
.badge.ok { color: var(--ok); } .badge.warn { color: var(--warn); } .badge.error { color: var(--err); } .badge.pending { color: var(--muted); }
.badge details summary { cursor: pointer; }
.badge pre { margin-top: 4px; max-height: 160px; overflow: auto; color: var(--fg); }
.error { color: var(--err); white-space: pre-wrap; }
footer { border-top: 1px solid var(--border); padding: 10px 12px 6px; display: flex; flex-direction: column; gap: 6px; }
textarea { width: 100%; min-height: 60px; max-height: 160px; resize: vertical; font: inherit; color: var(--fg); background: var(--bg);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
textarea:focus { outline: 2px solid var(--brand); outline-offset: -1px; }
.row { display: flex; align-items: center; gap: 8px; }
.row label { flex: 1; color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
.row input { accent-color: var(--brand); }
.powered { display: flex; justify-content: center; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); }
.powered a { color: var(--muted); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; font-family: "Fira Code", ui-monospace, monospace; }
.powered a:hover { color: var(--brand); }
.powered a svg { color: var(--brand); }
`;

const EXAMPLES = [
  "Request rate per service over the last 5 minutes",
  "p95 HTTP latency by route",
  "Which pods use the most memory?",
  "Explain the query in the editor",
];

export class Panel {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly fab: HTMLButtonElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly includeQuery: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly modeButtons: HTMLButtonElement[];
  private progressEl: HTMLElement | null = null;
  private busy = false;

  constructor(
    private readonly handlers: PanelHandlers,
    mode: ResponseMode,
  ) {
    this.host = document.createElement("promql-ai-panel");
    const shadow = this.host.attachShadow({ mode: "open" });
    // Static markup only; all dynamic text below is set with textContent.
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="root">
        <button class="fab" title="Ask AI to write PromQL (Alt+Shift+P)">${ICONS.sparkle}<span>Ask AI</span></button>
        <section class="panel hidden" role="dialog" aria-label="PromQL AI Assistant">
          <header>
            <h1><span class="mark">${ICONS.sparkle}</span>PromQL AI Assistant</h1>
            <button class="icon" data-act="reset" title="New chat" aria-label="New chat">${ICONS.plus}</button>
            <button class="icon" data-act="settings" title="Settings" aria-label="Settings">${ICONS.gear}</button>
            <button class="icon" data-act="close" title="Close (Esc)" aria-label="Close">${ICONS.close}</button>
          </header>
          <div class="modes">
            <span class="label">Answers</span>
            <div class="seg" role="group" aria-label="Answer style">
              <button data-mode="concise" title="Short answers: the query plus a one-line explanation">${ICONS.bolt}Concise</button>
              <button data-mode="educational" title="Step-by-step explanations that teach PromQL">${ICONS.book}Educational</button>
            </div>
          </div>
          <div class="log"></div>
          <footer>
            <textarea placeholder="Describe the query you need… (Ctrl/⌘+Enter to send)"></textarea>
            <div class="row">
              <label><input type="checkbox" checked> Include the query in the editor</label>
              <button class="btn primary" data-act="send">${ICONS.sparkle}<span>Ask AI</span></button>
            </div>
            <div class="powered">Powered by <a href="https://devoriales.com" target="_blank" rel="noopener">${ICONS.devoriales}devoriales.com</a></div>
          </footer>
        </section>
      </div>`;
    const $ = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;
    this.root = $(".root");
    this.panel = $(".panel");
    this.fab = $(".fab");
    this.log = $(".log");
    this.input = $("textarea");
    this.includeQuery = $("input[type=checkbox]");
    this.sendBtn = $("[data-act=send]");
    this.modeButtons = [...shadow.querySelectorAll<HTMLButtonElement>("[data-mode]")];

    this.fab.addEventListener("click", () => this.open());
    $("[data-act=close]").addEventListener("click", () => this.close());
    $("[data-act=settings]").addEventListener("click", () => handlers.onOpenSettings());
    $("[data-act=reset]").addEventListener("click", () => {
      if (this.busy) return;
      handlers.onReset();
      this.renderEmpty();
    });
    for (const b of this.modeButtons) {
      b.addEventListener("click", () => {
        const m = b.dataset.mode as ResponseMode;
        this.setMode(m);
        handlers.onModeChange(m);
      });
    }
    this.setMode(mode);
    this.sendBtn.addEventListener("click", () => this.submit());
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep Prometheus' global shortcuts out of our textarea
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit();
      } else if (e.key === "Escape") this.close();
    });
    this.renderEmpty();
    this.applyTheme();
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mantine-color-scheme"] });
    document.documentElement.appendChild(this.host);
  }

  setMode(mode: ResponseMode): void {
    for (const b of this.modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }

  private applyTheme(): void {
    this.root.classList.toggle("dark", pageColorScheme() === "dark");
  }

  open(): void {
    this.panel.classList.remove("hidden");
    this.fab.classList.add("hidden");
    this.input.focus();
  }

  close(): void {
    this.panel.classList.add("hidden");
    this.fab.classList.remove("hidden");
  }

  toggle(): void {
    this.panel.classList.contains("hidden") ? this.open() : this.close();
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = "";
    this.log.querySelector(".empty")?.remove();
    this.append("div", "msg-user").textContent = text;
    this.setBusy(true);
    this.handlers.onAsk(text, this.includeQuery.checked);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.sendBtn.querySelector("span")!.textContent = busy ? "Working…" : "Ask AI";
    if (!busy) {
      this.progressEl?.classList.add("done");
      this.progressEl = null;
    }
  }

  private renderEmpty(): void {
    this.log.textContent = "";
    const empty = this.append("div", "empty");
    empty.textContent =
      "Describe what you want to see. The assistant looks up the metrics and labels on this server, tests the query, and you can insert it into the editor. Try:";
    const ul = document.createElement("ul");
    for (const ex of EXAMPLES) {
      const li = document.createElement("li");
      li.textContent = ex;
      li.addEventListener("click", () => {
        this.input.value = ex;
        this.input.focus();
      });
      ul.appendChild(li);
    }
    empty.appendChild(ul);
  }

  private append(tag: string, cls: string): HTMLElement {
    const el = document.createElement(tag);
    el.className = cls;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  progress(text: string): void {
    this.progressEl ??= this.append("div", "progress");
    const last = this.progressEl.lastElementChild;
    if (last?.textContent === text) return;
    if (last?.textContent === "Thinking…") last.remove(); // collapse consecutive "Thinking…" lines
    const step = document.createElement("span");
    step.className = "step";
    step.textContent = text;
    this.progressEl.appendChild(step);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Returns a setter for the validation badge of this answer. */
  answer(text: string, query: string | null): (badge: Badge) => void {
    const last = this.progressEl?.lastElementChild;
    if (last?.textContent === "Thinking…") last.remove();
    this.setBusy(false);
    const card = this.append("div", "answer");
    if (query) {
      const pre = document.createElement("pre");
      pre.className = "query";
      pre.textContent = query;
      card.appendChild(pre);
    }
    if (text) {
      const body = document.createElement("div");
      body.className = "text";
      body.innerHTML = renderMarkdown(text); // renderMarkdown HTML-escapes everything before formatting
      card.appendChild(body);
    }
    const badgeEl = document.createElement("div");
    badgeEl.className = "badge hidden";
    if (query) {
      card.appendChild(badgeEl);
      const actions = document.createElement("div");
      actions.className = "actions";
      const mk = (label: string, icon: string, cls: string, fn: () => void) => {
        const b = document.createElement("button");
        b.className = `btn ${cls}`;
        b.innerHTML = icon; // static icon markup from ICONS
        const span = document.createElement("span");
        span.textContent = label;
        b.appendChild(span);
        b.addEventListener("click", fn);
        actions.appendChild(b);
        return span;
      };
      mk("Insert & run", ICONS.play, "primary", () => this.handlers.onInsert(query, true));
      mk("Insert", ICONS.insert, "", () => this.handlers.onInsert(query, false));
      const copyLabel = mk("Copy", ICONS.copy, "", async () => {
        await navigator.clipboard.writeText(query);
        copyLabel.textContent = "Copied";
        setTimeout(() => (copyLabel.textContent = "Copy"), 1200);
      });
      card.appendChild(actions);
    }
    this.log.scrollTop = this.log.scrollHeight;
    return (badge) => {
      badgeEl.className = `badge ${badge.kind}`;
      const icon = { ok: "✓", warn: "⚠", error: "✗", pending: "…" }[badge.kind];
      badgeEl.textContent = "";
      if (badge.detail) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${icon} ${badge.text}`;
        const pre = document.createElement("pre");
        pre.textContent = badge.detail;
        details.append(summary, pre);
        badgeEl.appendChild(details);
      } else {
        badgeEl.textContent = `${icon} ${badge.text}`;
      }
    };
  }

  error(message: string): void {
    this.setBusy(false);
    this.append("div", "error").textContent = message;
  }
}
