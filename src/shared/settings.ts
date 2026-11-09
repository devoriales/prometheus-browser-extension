// User-configurable settings. Non-secret values live in chrome.storage.sync so
// they follow the user across browsers; secrets stay in chrome.storage.local.

export type ProviderKind = "anthropic" | "gateway" | "claude-code";
export type GatewayAuth = "x-api-key" | "bearer" | "none";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ValidationMode = "execute" | "syntax" | "off";
export type InsertMode = "auto" | "url";
export type ResponseMode = "concise" | "educational";

export interface PrometheusInstance {
  id: string;
  name: string;
  /** Base URL of the Prometheus UI/API, including any route prefix, e.g. https://mon.example.com/prometheus/ */
  baseUrl: string;
  /** Extra headers for API calls, e.g. X-Scope-OrgID for Mimir/Cortex tenants. One "Name: value" per line. */
  headers: string;
  /** Free-text context about this environment (label conventions, recording rules, ...). Sent to Claude. */
  notes: string;
}

export interface Settings {
  provider: ProviderKind;
  /** Model for the Anthropic API and gateway providers. */
  model: string;
  /** Model alias or ID passed to Claude Code (`--model`). Empty = Claude Code's default. */
  claudeCodeModel: string;
  /** Empty string = do not send effort (model default). */
  effort: Effort | "";
  /** Gateway only: base URL that speaks the Anthropic Messages API (LiteLLM, internal proxy, ...). */
  gatewayBaseUrl: string;
  gatewayAuth: GatewayAuth;
  /** Extra request headers for the gateway, one "Name: value" per line. */
  gatewayHeaders: string;
  /** Anthropic API only: re-run declined requests on Anthropic's recommended fallback model. */
  refusalFallback: boolean;
  /** Claude Code only: strip ANTHROPIC_API_KEY so usage is billed to the subscription. */
  claudeCodeForceSubscription: boolean;

  instances: PrometheusInstance[];
  validation: ValidationMode;
  /** Inline the full metric-name list into the (cached) system prompt when there are at most this many metrics. 0 disables. */
  inlineMetricLimit: number;
  maxLabelValues: number;
  maxToolRounds: number;
  queryTimeoutSeconds: number;
  insertMode: InsertMode;
  /** Global instructions appended to the system prompt (team conventions etc.). */
  customInstructions: string;
  /** Chat answer style, switchable in the panel. */
  responseMode: ResponseMode;
}

export interface Secrets {
  /** Anthropic API key (sk-ant-...) or gateway token, depending on provider. */
  anthropicApiKey: string;
  gatewayToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  claudeCodeModel: "",
  effort: "medium",
  gatewayBaseUrl: "",
  gatewayAuth: "bearer",
  gatewayHeaders: "",
  refusalFallback: true,
  claudeCodeForceSubscription: true,
  instances: [],
  validation: "execute",
  inlineMetricLimit: 1500,
  maxLabelValues: 25,
  maxToolRounds: 8,
  queryTimeoutSeconds: 10,
  insertMode: "auto",
  customInstructions: "",
  responseMode: "concise",
};

export const DEFAULT_SECRETS: Secrets = { anthropicApiKey: "", gatewayToken: "" };

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

export async function loadSecrets(): Promise<Secrets> {
  const stored = await chrome.storage.local.get("secrets");
  return { ...DEFAULT_SECRETS, ...(stored.secrets ?? {}) };
}

export async function saveSecrets(secrets: Secrets): Promise<void> {
  await chrome.storage.local.set({ secrets });
}

/** Parse "Name: value" lines into a header record, ignoring blanks and malformed lines. */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

/** Normalise a base URL so it always ends with "/". */
export function normaliseBaseUrl(url: string): string {
  const u = new URL(url.trim());
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.toString();
}

/** Chrome match pattern covering an instance. Ports are omitted: Chrome patterns without a port match any port. */
export function matchPatternFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Find the configured instance whose base URL prefixes the given page URL (longest prefix wins). */
export function findInstance(instances: PrometheusInstance[], pageUrl: string): PrometheusInstance | undefined {
  return instances
    .filter((i) => {
      try {
        return pageUrl.startsWith(normaliseBaseUrl(i.baseUrl)) || pageUrl === normaliseBaseUrl(i.baseUrl).slice(0, -1);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.baseUrl.length - a.baseUrl.length)[0];
}

/** Known Prometheus UI routes; used to guess an instance base URL from the current page. */
const UI_ROUTES = ["query", "graph", "alerts", "rules", "targets", "service-discovery", "status", "flags", "config", "tsdb-status", "agent", "classic"];

export function guessBaseUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  const parts = u.pathname.split("/").filter(Boolean);
  const routeIdx = parts.findIndex((p) => UI_ROUTES.includes(p));
  const prefix = routeIdx >= 0 ? parts.slice(0, routeIdx) : parts;
  return `${u.origin}/${prefix.length ? prefix.join("/") + "/" : ""}`;
}
