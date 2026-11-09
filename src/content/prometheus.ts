// Prometheus HTTP API client used for Claude's tools. It runs in the content
// script, so requests go to the page's own origin and carry the user's
// existing session (cookies, SSO), plus any per-instance extra headers.

export interface MetricMeta {
  type: string;
  help: string;
  unit: string;
}

type FetchFn = typeof fetch;

export class PrometheusError extends Error {}

export class PrometheusClient {
  private namesPromise: Promise<string[]> | null = null;
  private metaPromise: Promise<Map<string, MetricMeta>> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutSeconds = 10,
    private readonly fetchFn: FetchFn = (...args) => fetch(...args),
  ) {}

  private url(path: string, params?: URLSearchParams): string {
    return `${this.baseUrl}api/v1/${path}${params && [...params].length ? `?${params}` : ""}`;
  }

  private async request<T>(path: string, params?: URLSearchParams, post = false): Promise<T> {
    const init: RequestInit = { headers: { ...this.headers }, credentials: "include" };
    let url = this.url(path, post ? undefined : params);
    if (post) {
      init.method = "POST";
      init.body = params;
      (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.timeoutSeconds + 5) * 1000);
    init.signal = controller.signal;
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new PrometheusError(controller.signal.aborted ? "Request to Prometheus timed out." : `Request failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new PrometheusError(`HTTP ${res.status} from ${path} (not a Prometheus API response)`);
    }
    if (body.status !== "success") {
      throw new PrometheusError(`${body.errorType ?? `HTTP ${res.status}`}: ${body.error ?? "unknown error"}`);
    }
    return Object.assign(body.data as object, { __warnings: body.warnings ?? [], __infos: body.infos ?? [] }) as T;
  }

  async version(): Promise<string> {
    try {
      const data = await this.request<{ version?: string }>("status/buildinfo");
      return data.version ?? "";
    } catch {
      return ""; // not all Prometheus-compatible backends expose buildinfo
    }
  }

  metricNames(): Promise<string[]> {
    this.namesPromise ??= this.request<string[]>("label/__name__/values")
      .then((names) => [...names].sort())
      .catch((err) => {
        this.namesPromise = null;
        throw err;
      });
    return this.namesPromise;
  }

  metadata(): Promise<Map<string, MetricMeta>> {
    this.metaPromise ??= this.request<Record<string, MetricMeta[]>>("metadata")
      .then((data) => {
        const map = new Map<string, MetricMeta>();
        for (const [name, entries] of Object.entries(data)) if (!name.startsWith("__") && entries?.[0]) map.set(name, entries[0]);
        return map;
      })
      .catch(() => new Map<string, MetricMeta>()); // metadata is optional (e.g. some remote-write backends)
    return this.metaPromise;
  }

  /** "name type" lines for the system prompt, or null if there are more than `limit` metrics. */
  async inlineMetricList(limit: number): Promise<{ count: number; list: string | null }> {
    const names = await this.metricNames();
    if (limit <= 0 || names.length > limit) return { count: names.length, list: null };
    const meta = await this.metadata();
    return { count: names.length, list: names.map((n) => `${n} ${typeOf(n, meta)}`).join("\n") };
  }

  async searchMetrics(pattern: string, limit = 50): Promise<string> {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const [names, meta] = await Promise.all([this.metricNames(), this.metadata()]);
    const hits = names.filter((n) => re.test(n) || re.test(meta.get(baseName(n, meta))?.help ?? ""));
    if (!hits.length) return `No metrics match /${pattern}/i (searched ${names.length} metric names). Try a broader pattern.`;
    const lines = hits.slice(0, limit).map((n) => {
      const m = meta.get(baseName(n, meta));
      return `${n} | ${typeOf(n, meta)}${m?.unit ? ` | unit=${m.unit}` : ""}${m?.help ? ` | ${m.help}` : ""}`;
    });
    const more = hits.length > limit ? `\n…and ${hits.length - limit} more; use a narrower pattern.` : "";
    return `${hits.length} metric(s) match. name | type | help\n${lines.join("\n")}${more}`;
  }

  async metricLabels(metric: string, maxValues: number): Promise<string> {
    const match = `{__name__=${JSON.stringify(metric)}}`;
    const start = String(Math.floor(Date.now() / 1000) - 3600);
    const names = await this.request<string[]>("labels", new URLSearchParams({ "match[]": match, start }));
    const labels = names.filter((n) => n !== "__name__");
    if (!names.length) return `No series for ${metric} in the last hour. Check the name with search_metrics.`;
    if (!labels.length) return `${metric} has no labels besides __name__.`;
    const values = await Promise.all(
      labels.slice(0, 40).map(async (label) => {
        try {
          const v = await this.request<string[]>(
            `label/${encodeURIComponent(label)}/values`,
            new URLSearchParams({ "match[]": match, start, limit: String(maxValues + 1) }),
          );
          const shown = v.slice(0, maxValues).map((x) => JSON.stringify(x)).join(", ");
          return `${label}: ${shown}${v.length > maxValues ? ", …" : ""}`;
        } catch (err) {
          return `${label}: (could not load values: ${(err as Error).message})`;
        }
      }),
    );
    const extra = labels.length > 40 ? `\n…and ${labels.length - 40} more labels.` : "";
    return `Labels of ${metric} (last hour):\n${values.join("\n")}${extra}`;
  }

  /** Validate a query. "execute" runs it as an instant query; "syntax" only parses it. */
  async checkQuery(query: string, mode: "execute" | "syntax"): Promise<string> {
    if (mode === "syntax") {
      try {
        const formatted = await this.request<string>("format_query", new URLSearchParams({ query }), true);
        return `Syntax OK. Formatted:\n${String(formatted)}`;
      } catch (err) {
        if (/404|not a Prometheus API/.test((err as Error).message)) {
          return "This server does not offer a syntax-check endpoint; the query could not be checked.";
        }
        throw err;
      }
    }
    const data = await this.request<{ resultType: string; result: any; __warnings: string[]; __infos: string[] }>(
      "query",
      new URLSearchParams({ query, timeout: `${this.timeoutSeconds}s`, limit: "200" }),
      true,
    );
    return summariseResult(data);
  }
}

function summariseResult(data: { resultType: string; result: any; __warnings: string[]; __infos: string[] }): string {
  const out: string[] = [];
  if (data.__warnings.length) out.push(`Warnings: ${data.__warnings.join("; ")}`);
  if (data.__infos.length) out.push(`Info: ${data.__infos.join("; ")}`);
  if (data.resultType === "scalar" || data.resultType === "string") {
    out.unshift(`OK. ${data.resultType} result: ${JSON.stringify(data.result?.[1])}`);
    return out.join("\n");
  }
  const series: Array<{ metric: Record<string, string>; value?: [number, string]; values?: unknown[]; histogram?: unknown }> =
    data.result ?? [];
  if (!series.length) {
    out.unshift("OK, but the query returned no series right now. Check metric names, label matchers and label values.");
    return out.join("\n");
  }
  out.unshift(`OK. ${data.resultType} with ${series.length}${series.length >= 200 ? "+" : ""} series. Sample:`);
  for (const s of series.slice(0, 8)) {
    const labels = Object.entries(s.metric).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    const value = s.value ? s.value[1] : s.histogram ? "(native histogram)" : "";
    out.push(`{${labels}} ${value}`);
  }
  return out.join("\n");
}

const SUFFIXES = ["_bucket", "_count", "_sum", "_total", "_created", "_info"];

/** Map classic-histogram/summary series names back to the family name that metadata is keyed by. */
function baseName(name: string, meta: Map<string, MetricMeta>): string {
  if (meta.has(name)) return name;
  for (const s of SUFFIXES) if (name.endsWith(s) && meta.has(name.slice(0, -s.length))) return name.slice(0, -s.length);
  return name;
}

function typeOf(name: string, meta: Map<string, MetricMeta>): string {
  const base = baseName(name, meta);
  const t = meta.get(base)?.type ?? "unknown";
  if (base !== name && (t === "histogram" || t === "summary")) return `${t} (${name.slice(base.length + 1)} series)`;
  return t;
}
