import { PORT_NAME, type AskContext, type RuntimeRequest, type RuntimeTabMessage, type ToBackground, type ToContent } from "../shared/protocol";
import { findInstance, loadSettings, normaliseBaseUrl, parseHeaderLines, saveSettings, type PrometheusInstance, type Settings } from "../shared/settings";
import { findEditor, insertQuery, readQuery, runQuery } from "./editor";
import { Panel, type Badge } from "./panel";
import { PrometheusClient } from "./prometheus";

declare global {
  interface Window {
    __promqlAiLoaded?: boolean;
  }
}

const IDLE_LIMIT_MS = 30 * 60_000;

if (!window.__promqlAiLoaded) {
  window.__promqlAiLoaded = true;
  void main();
}

async function main(): Promise<void> {
  const settings = await loadSettings();
  const instance = findInstance(settings.instances, location.href);
  if (!instance) return; // host is granted, but this path is not a configured Prometheus
  new Assistant(settings, instance);
}

class Assistant {
  private port: chrome.runtime.Port | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private readonly prom: PrometheusClient;
  private readonly panel: Panel;
  private versionPromise: Promise<string> | null = null;
  private lastActivity = Date.now();

  constructor(
    private settings: Settings,
    private readonly instance: PrometheusInstance,
  ) {
    this.prom = new PrometheusClient(normaliseBaseUrl(instance.baseUrl), parseHeaderLines(instance.headers), settings.queryTimeoutSeconds);
    this.panel = new Panel({
      onAsk: (text, include) => void this.ask(text, include),
      onReset: () => this.endConversation(),
      onInsert: (query, run) => void this.insert(query, run),
      onOpenSettings: () => void chrome.runtime.sendMessage({ type: "openOptions" } satisfies RuntimeRequest),
      onModeChange: (mode) => {
        this.settings.responseMode = mode;
        void loadSettings().then((s) => saveSettings({ ...s, responseMode: mode }));
      },
    }, settings.responseMode);
    chrome.runtime.onMessage.addListener((msg: RuntimeTabMessage) => {
      if (msg.type === "togglePanel") this.panel.toggle();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings)
        void loadSettings().then((s) => {
          this.settings = s;
          this.panel.setMode(s.responseMode);
        });
    });
  }

  /**
   * The conversation lives in the service worker for as long as this port is
   * open. MV3 stops idle service workers after ~30s, so ping while a
   * conversation exists, and end it after a long idle period.
   */
  private connect(): chrome.runtime.Port {
    if (this.port) return this.port;
    const port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((msg: ToContent) => void this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      if (this.port === port) {
        this.port = null;
        this.stopKeepAlive();
        this.panel.error("Connection to the extension was reset. The next question starts a new conversation.");
      }
    });
    this.port = port;
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_LIMIT_MS) return this.endConversation();
      port.postMessage({ type: "ping" } satisfies ToBackground);
    }, 20_000);
    return port;
  }

  private endConversation(): void {
    this.stopKeepAlive();
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }

  private send(msg: ToBackground): void {
    this.lastActivity = Date.now();
    this.connect().postMessage(msg);
  }

  private async ask(text: string, includeEditorQuery: boolean): Promise<void> {
    try {
      this.versionPromise ??= this.prom.version();
      const [version, metrics] = await Promise.all([this.versionPromise, this.prom.inlineMetricList(this.settings.inlineMetricLimit)]);
      const context: AskContext = {
        instanceId: this.instance.id,
        pageUrl: location.href,
        currentQuery: includeEditorQuery ? readQuery() : "",
        prometheusVersion: version,
        metricCount: metrics.count,
        inlineMetrics: metrics.list,
        validation: this.settings.validation,
        mode: this.settings.responseMode,
      };
      this.send({ type: "ask", text, context });
    } catch (err) {
      this.panel.error(`Could not read from Prometheus: ${(err as Error).message}`);
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private async onMessage(msg: ToContent): Promise<void> {
    switch (msg.type) {
      case "progress":
        this.panel.progress(msg.text);
        return;
      case "error":
        this.panel.error(msg.message);
        return;
      case "answer": {
        const setBadge = this.panel.answer(msg.text, msg.query);
        if (msg.query) await this.validate(msg.query, setBadge);
        return;
      }
      case "toolCall": {
        let content: string;
        let isError = false;
        try {
          content = await this.runTool(msg.name, msg.input);
        } catch (err) {
          content = (err as Error).message;
          isError = true;
        }
        this.send({ type: "toolResult", callId: msg.callId, content, isError });
      }
    }
  }

  private runTool(name: string, input: Record<string, unknown>): Promise<string> {
    const str = (k: string) => String(input[k] ?? "").trim();
    switch (name) {
      case "search_metrics":
        return this.prom.searchMetrics(str("pattern") || ".");
      case "get_metric_labels":
        return this.prom.metricLabels(str("metric"), this.settings.maxLabelValues);
      case "run_query":
        if (this.settings.validation === "off") return Promise.resolve("Query checking is disabled.");
        return this.prom.checkQuery(str("query"), this.settings.validation);
      default:
        return Promise.reject(new Error(`Unknown tool: ${name}`));
    }
  }

  private async validate(query: string, setBadge: (b: Badge) => void): Promise<void> {
    if (this.settings.validation === "off") return;
    setBadge({ kind: "pending", text: "Checking query on this server…" });
    try {
      const summary = await this.prom.checkQuery(query, this.settings.validation);
      if (/no series/.test(summary)) setBadge({ kind: "warn", text: "Valid, but returns no series right now", detail: summary });
      else if (/could not be checked/.test(summary)) setBadge({ kind: "warn", text: "Not checked", detail: summary });
      else {
        const m = summary.match(/with (\d+\+?) series/);
        setBadge({ kind: "ok", text: m ? `Valid · ${m[1]} series` : "Valid", detail: summary });
      }
    } catch (err) {
      setBadge({ kind: "error", text: "Prometheus rejected this query", detail: (err as Error).message });
    }
  }

  private async insert(query: string, run: boolean): Promise<void> {
    const how = await insertQuery(query, this.settings.insertMode);
    if (how === "editor" && run) await runQuery(findEditor());
  }
}
