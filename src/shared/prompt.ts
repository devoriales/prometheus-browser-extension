// Tool definitions and prompt text shared by both engines (Anthropic API and
// Claude Code bridge). The tools execute in the content script, against the
// Prometheus HTTP API of the page the user is on.

import type { AskContext } from "./protocol";
import type { PrometheusInstance, Settings } from "./settings";

export type ToolName = "search_metrics" | "get_metric_labels" | "run_query" | "submit_query";

export interface ToolSpec {
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export function toolSpecs(validation: Settings["validation"]): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: "search_metrics",
      description:
        "Search the metric names that exist on this Prometheus server. Matches a case-insensitive regular expression " +
        "(a plain word works too) against metric names and their HELP text. Returns up to 50 matches with type, unit and help. " +
        "Use it before relying on any metric name you have not already confirmed.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or substring, e.g. 'http_.*duration' or 'memory'." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    {
      name: "get_metric_labels",
      description:
        "List the label names of one metric (series seen in the last hour) and a sample of values for each label. " +
        "Use it to pick correct label names and values for matchers and by()/without() clauses.",
      input_schema: {
        type: "object",
        properties: { metric: { type: "string", description: "Exact metric name." } },
        required: ["metric"],
        additionalProperties: false,
      },
    },
  ];
  if (validation !== "off") {
    tools.push({
      name: "run_query",
      description:
        validation === "execute"
          ? "Run a PromQL instant query on this server and get a short summary: errors, warnings, number of series and a few sample series. " +
            "Use it to check your final query before submitting."
          : "Check a PromQL expression for syntax errors on this server (the query is parsed, not executed). " +
            "Use it to check your final query before submitting.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "PromQL expression." } },
        required: ["query"],
        additionalProperties: false,
      },
    });
  }
  tools.push({
    name: "submit_query",
    description:
      "Give the user the final PromQL query. Call it once, as your last action, when you have a query for the user. " +
      "It will be shown with your explanation and can be inserted into the Prometheus editor.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The final PromQL expression, formatted for readability." },
        explanation: {
          type: "string",
          description: "Markdown explanation in the response style the user asked for: what the query computes, and any assumption the user should check.",
        },
      },
      required: ["query", "explanation"],
      additionalProperties: false,
    },
  });
  return tools;
}

/** Stable instructions: identical for every request, so they form the cached prefix. */
export const BASE_INSTRUCTIONS = `You are a PromQL expert built into the Prometheus web UI. You help the user write, fix and explain PromQL queries for the specific Prometheus server they are looking at.

How to work:
- Only use metric names and label names that exist on this server. If a name is not in the metric list below and has not been confirmed earlier in the conversation, look it up with search_metrics, and check labels with get_metric_labels before you put them in matchers or by()/without() clauses.
- Respect metric types. Use rate()/increase() only on counters (usually *_total, *_count, *_sum, *_bucket). Use histogram_quantile() on rate() of *_bucket series and keep "le" in the by() clause; for native histograms (type histogram without *_bucket series) call histogram_quantile() on rate() of the metric itself. Never rate() a gauge; use deriv(), delta() or *_over_time() functions instead.
- Default to a [5m] range window unless the user asks otherwise, and aggregate (sum/avg/max by (...)) so the result has a readable number of series.
- Before you submit, check the final query with run_query when that tool is available. Fix errors. If it returns no series, re-check label values and names instead of guessing.
- Finish by calling submit_query exactly once with the final query and a short explanation. If the user only asks a question that does not need a new query (for example, "what does this query do?"), answer in plain text and do not call submit_query.
- If the editor already contains a query and the user asks to change, fix or extend it, start from that query.
- Each user message states a response style (concise or educational). Follow it for the explanation and for plain-text answers. Mention assumptions (for example, which label identifies a service) so the user can correct you.`;

/** Per-instance environment context. Changes only when settings or the metric list change, so it is cached too. */
export function environmentBlock(settings: Settings, instance: PrometheusInstance | undefined, ctx: AskContext): string {
  const parts: string[] = [];
  parts.push(`Prometheus server: ${instance?.name || "unnamed"}${ctx.prometheusVersion ? ` (version ${ctx.prometheusVersion})` : ""}.`);
  if (instance?.notes.trim()) parts.push(`Notes about this environment from the user:\n${instance.notes.trim()}`);
  if (settings.customInstructions.trim()) parts.push(`Team instructions from the user:\n${settings.customInstructions.trim()}`);
  if (ctx.inlineMetrics) {
    parts.push(
      `This server has ${ctx.metricCount} metric names. Full list ("name type", type is "unknown" when no metadata exists):\n${ctx.inlineMetrics}`,
    );
  } else {
    parts.push(`This server has ${ctx.metricCount} metric names, too many to list here. Use search_metrics to find them.`);
  }
  return parts.join("\n\n");
}

export const RESPONSE_STYLES = {
  concise:
    "Response style: concise. Keep the explanation to one or two short sentences, with no background theory. Plain-text answers: at most three sentences.",
  educational:
    "Response style: educational. The user is learning PromQL. Explain the query piece by piece as short markdown bullets (selector and matchers, range window, functions, aggregation), say why each part is needed, and end with one common mistake or useful variation. Stay under about 200 words.",
} as const;

/** The per-question user message: volatile context (style, editor query) goes here, after the cached prefix. */
export function userMessage(text: string, ctx: AskContext): string {
  const lines = [text.trim(), "", RESPONSE_STYLES[ctx.mode]];
  if (ctx.currentQuery.trim()) {
    lines.push("", "Query currently in the Prometheus editor:", "```promql", ctx.currentQuery.trim(), "```");
  }
  return lines.join("\n");
}

/** Instructions for engines without native tool use: one JSON action per turn. */
export function actionProtocolInstructions(tools: ToolSpec[]): string {
  const toolList = tools
    .filter((t) => t.name !== "submit_query")
    .map((t) => `- "${t.name}" with ${Object.keys(t.input_schema.properties).map((p) => `"${p}"`).join(", ")}: ${t.description}`)
    .join("\n");
  return `You cannot call tools directly. Instead, every reply is a single JSON object that chooses one action:
${toolList}
- "submit_query" with "query" and "explanation": give the user the final query (this ends your turn).
- "reply" with "text": answer in plain text without a query (this ends your turn).
After a lookup action, the next message contains its result. Take one action at a time.`;
}

export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search_metrics", "get_metric_labels", "run_query", "submit_query", "reply"] },
    pattern: { type: "string" },
    metric: { type: "string" },
    query: { type: "string" },
    explanation: { type: "string" },
    text: { type: "string" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export function describeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_metrics":
      return `Searching metrics for “${String(input.pattern ?? "")}”`;
    case "get_metric_labels":
      return `Reading labels of ${String(input.metric ?? "")}`;
    case "run_query":
      return `Testing query: ${String(input.query ?? "")}`;
    default:
      return name;
  }
}
