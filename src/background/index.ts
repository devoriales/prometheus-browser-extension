import { PORT_NAME, type RuntimeRequest } from "../shared/protocol";
import { findInstance, guessBaseUrl, loadSecrets, loadSettings, matchPatternFor } from "../shared/settings";
import { ChatSession } from "./agent";
import { createClient, describeApiError } from "./engines/anthropic";
import { callBridge } from "./engines/claudeCode";

const SCRIPT_ID = "promql-ai";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_NAME) new ChatSession(port);
});

/**
 * Register the content script for every configured Prometheus instance whose
 * host the user has granted. Hosts are user-configured, so registration is
 * dynamic instead of static manifest matches.
 */
let syncQueue: Promise<void> = Promise.resolve();

/**
 * Saving settings fires several triggers at once (permission granted, storage
 * changed, explicit request). Run syncs one after another; concurrent
 * unregister/register calls fail with "Duplicate script ID".
 */
function syncContentScripts(): Promise<void> {
  const run = syncQueue.then(doSyncContentScripts);
  syncQueue = run.catch((err) => console.warn("PromQL AI: content script sync failed:", err));
  return run;
}

async function doSyncContentScripts(): Promise<void> {
  const settings = await loadSettings();
  const patterns = [...new Set(settings.instances.map((i) => safe(() => matchPatternFor(i.baseUrl))).filter(Boolean))] as string[];
  const granted: string[] = [];
  for (const p of patterns) if (await chrome.permissions.contains({ origins: [p] })) granted.push(p);

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (granted.length) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: granted, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true },
    ]);
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

chrome.runtime.onInstalled.addListener(() => void syncContentScripts().catch(() => {}));
chrome.runtime.onStartup.addListener(() => void syncContentScripts().catch(() => {}));
chrome.permissions.onAdded.addListener(() => void syncContentScripts().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => void syncContentScripts().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) void syncContentScripts().catch(() => {});
});

/** Toolbar button: toggle the panel on a configured Prometheus page, otherwise offer to add the site. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  const settings = await loadSettings();
  const instance = findInstance(settings.instances, tab.url);
  if (!instance || !(await chrome.permissions.contains({ origins: [matchPatternFor(instance.baseUrl)] }))) {
    await openOptions(/^https?:/.test(tab.url) ? guessBaseUrl(tab.url) : undefined);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "togglePanel" });
  } catch {
    // Tab was open before the script was registered: inject now, then toggle.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "togglePanel" });
  }
});

async function openOptions(addBaseUrl?: string): Promise<void> {
  const url = chrome.runtime.getURL("options.html") + (addBaseUrl ? `?add=${encodeURIComponent(addBaseUrl)}` : "");
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg: RuntimeRequest, sender, sendResponse) => {
  void handleRuntime(msg, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // async response
});

async function handleRuntime(msg: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case "insertMainWorld": {
      if (!sender.tab?.id) return { ok: false };
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
        world: "MAIN",
        func: setEditorInMainWorld,
        args: [msg.query],
      });
      return { ok: res?.result === true };
    }
    case "openOptions":
      await openOptions(msg.addBaseUrl);
      return { ok: true };
    case "syncContentScripts":
      await syncContentScripts();
      return { ok: true };
    case "testProvider":
      return testProvider();
  }
}

/**
 * Runs in the page's MAIN world: find the CodeMirror 6 EditorView behind the
 * editor the content script marked, and replace its document. Must be
 * self-contained (it is serialised by chrome.scripting).
 */
function setEditorInMainWorld(query: string): boolean {
  const content = document.querySelector("[data-promql-ai-target] .cm-content") as (HTMLElement & Record<string, any>) | null;
  if (!content) return false;
  const desc = content.cmView ?? content.cmTile;
  const view = desc?.rootView?.view ?? desc?.view ?? desc?.root?.view;
  if (!view || typeof view.dispatch !== "function") return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: query }, selection: { anchor: query.length } });
  view.focus();
  return true;
}

async function testProvider(): Promise<{ ok: boolean; message: string }> {
  const settings = await loadSettings();
  try {
    if (settings.provider === "claude-code") {
      const res = await callBridge({ type: "ping" });
      return res.ok
        ? { ok: true, message: `Bridge OK: ${res.version ?? "claude found"}` }
        : { ok: false, message: res.error ?? "Bridge error" };
    }
    const client = createClient(settings, await loadSecrets());
    const res = await client.messages.create({
      model: settings.model,
      max_tokens: 2048, // thinking is always on for current models; leave room for it
      ...(settings.effort ? { output_config: { effort: "low" as const } } : {}),
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { ok: true, message: `Connected to ${res.model}: “${text.trim()}”` };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}
