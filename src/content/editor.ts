// Reading and writing the Prometheus expression editor (CodeMirror 6 in both
// the v2 "new UI" and the v3 UI). Writing tries, in order:
//   1. the EditorView API in the page's main world (cleanest, keeps undo history),
//   2. a simulated paste via execCommand("insertText"),
//   3. reloading the page with the query in the URL (g0.expr).

import type { RuntimeRequest } from "../shared/protocol";

const TARGET_ATTR = "data-promql-ai-target";
let lastFocused: HTMLElement | null = null;

document.addEventListener(
  "focusin",
  (e) => {
    const editor = (e.target as HTMLElement | null)?.closest?.(".cm-editor") as HTMLElement | null;
    if (editor) lastFocused = editor;
  },
  true,
);

export function findEditor(): HTMLElement | null {
  if (lastFocused?.isConnected) return lastFocused;
  return document.querySelector<HTMLElement>(".cm-editor");
}

export function readQuery(editor = findEditor()): string {
  const content = editor?.querySelector(".cm-content");
  if (!content) return "";
  const clone = content.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".cm-placeholder, .cm-widgetBuffer, .cm-tooltip").forEach((el) => el.remove());
  const lines = [...clone.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "");
  return (lines.length ? lines.join("\n") : clone.textContent ?? "").trim();
}

export async function insertQuery(query: string, mode: "auto" | "url"): Promise<"editor" | "url"> {
  const editor = findEditor();
  if (mode === "auto" && editor) {
    document.querySelectorAll(`[${TARGET_ATTR}]`).forEach((el) => el.removeAttribute(TARGET_ATTR));
    editor.setAttribute(TARGET_ATTR, "1");
    try {
      const res = (await chrome.runtime.sendMessage({ type: "insertMainWorld", query } satisfies RuntimeRequest)) as { ok?: boolean };
      if (res?.ok && readQuery(editor) === query.trim()) return "editor";
    } catch {
      // fall through
    } finally {
      editor.removeAttribute(TARGET_ATTR);
    }
    if (insertViaInput(editor, query) && normalise(readQuery(editor)) === normalise(query)) return "editor";
  }
  navigateWithQuery(query);
  return "url";
}

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function insertViaInput(editor: HTMLElement, query: string): boolean {
  const content = editor.querySelector<HTMLElement>(".cm-content");
  if (!content) return false;
  content.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(content);
  sel?.removeAllRanges();
  sel?.addRange(range);
  // Deprecated but still the only way to produce a trusted-looking input that CodeMirror handles as typing.
  return document.execCommand("insertText", false, query);
}

function navigateWithQuery(query: string): void {
  const url = new URL(location.href);
  const isClassic = /\/graph\/?$/.test(url.pathname);
  url.search = "";
  url.searchParams.set("g0.expr", query);
  url.searchParams.set("g0.tab", isClassic ? "1" : "table");
  location.assign(url.toString());
}

/**
 * Click the panel's Execute button (or press Enter in the editor as a fallback).
 * Waits two frames first: the Prometheus UI copies the editor text into React
 * state asynchronously, and an immediate click would execute the old query.
 */
export async function runQuery(editor = findEditor()): Promise<void> {
  if (!editor) return;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  let node: HTMLElement | null = editor;
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const button = [...node.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^\s*execute\s*$/i.test(b.textContent ?? ""));
    if (button) {
      button.click();
      return;
    }
  }
  editor.querySelector(".cm-content")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
}

/** Prometheus v3 uses Mantine and sets the colour scheme on <html>. */
export function pageColorScheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-mantine-color-scheme");
  if (attr === "dark" || attr === "light") return attr;
  if (document.body?.classList.contains("bootstrap-dark")) return "dark"; // v2 UI dark theme
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
