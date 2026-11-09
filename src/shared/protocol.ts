// Messages exchanged between the content script (Prometheus page) and the
// background service worker over a long-lived chrome.runtime Port.

export const PORT_NAME = "promql-ai";

/** Context gathered on the page for one question. */
export interface AskContext {
  instanceId: string;
  pageUrl: string;
  currentQuery: string;
  prometheusVersion: string;
  metricCount: number;
  /** Full "name type" list, only present when the instance has few enough metrics to inline. */
  inlineMetrics: string | null;
  validation: "execute" | "syntax" | "off";
  mode: "concise" | "educational";
}

export type ToContent =
  | { type: "toolCall"; callId: string; name: string; input: Record<string, unknown> }
  | { type: "progress"; text: string }
  | { type: "answer"; text: string; query: string | null }
  | { type: "error"; message: string };

export type ToBackground =
  | { type: "ask"; text: string; context: AskContext }
  | { type: "toolResult"; callId: string; content: string; isError: boolean }
  | { type: "reset" }
  | { type: "ping" };

/** One-shot runtime messages (chrome.runtime.sendMessage). */
export type RuntimeRequest =
  | { type: "insertMainWorld"; query: string }
  | { type: "openOptions"; addBaseUrl?: string }
  | { type: "testProvider" }
  | { type: "syncContentScripts" };

export type RuntimeTabMessage = { type: "togglePanel" };
