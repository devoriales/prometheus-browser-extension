// Engine that calls the Claude Messages API with native tool use, either on
// api.anthropic.com (API key) or on a compatible gateway (token / custom auth).

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { parseHeaderLines, type Secrets, type Settings } from "../../shared/settings";
import type { ToolSpec } from "../../shared/prompt";
import { EngineError, type Engine, type EngineInput, type EngineStep } from "./types";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function createClient(settings: Settings, secrets: Secrets): Anthropic {
  if (settings.provider === "anthropic") {
    if (!secrets.anthropicApiKey) throw new EngineError("No Anthropic API key set. Add one in the extension options.");
    return new Anthropic({ apiKey: secrets.anthropicApiKey, dangerouslyAllowBrowser: true });
  }
  if (!settings.gatewayBaseUrl) throw new EngineError("No gateway URL set. Add one in the extension options.");
  const headers: Record<string, string | null> = parseHeaderLines(settings.gatewayHeaders);
  const common = { baseURL: settings.gatewayBaseUrl.replace(/\/+$/, ""), dangerouslyAllowBrowser: true };
  switch (settings.gatewayAuth) {
    case "x-api-key":
      return new Anthropic({ ...common, apiKey: secrets.gatewayToken, defaultHeaders: headers });
    case "bearer":
      return new Anthropic({ ...common, apiKey: null, authToken: secrets.gatewayToken, defaultHeaders: headers });
    case "none":
      // Explicitly omit auth headers; the gateway authenticates some other way (custom header, network).
      return new Anthropic({ ...common, apiKey: null, authToken: null, defaultHeaders: { ...headers, Authorization: null } });
  }
}

/** Server-side refusal fallback is a Claude API feature; Haiku models have none. */
function useRefusalFallback(settings: Settings): boolean {
  return settings.provider === "anthropic" && settings.refusalFallback && !settings.model.includes("haiku");
}

export class AnthropicEngine implements Engine {
  private readonly messages: BetaMessageParam[] = [];
  /** tool_use ids from the last assistant turn that still need a tool_result (e.g. submit_query). */
  private pendingToolUseIds: string[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly settings: Settings,
    private readonly system: BetaTextBlockParam[],
    private readonly tools: ToolSpec[],
  ) {}

  async send(input: EngineInput): Promise<EngineStep> {
    const content: BetaContentBlockParam[] = [];
    const answered = new Set<string>();
    if (input.kind === "toolResults") {
      for (const r of input.results) {
        answered.add(r.id);
        content.push({ type: "tool_result", tool_use_id: r.id, content: r.content, is_error: r.isError } satisfies BetaToolResultBlockParam);
      }
    }
    // Every tool_use must get a tool_result before the next user text.
    for (const id of this.pendingToolUseIds) {
      if (!answered.has(id)) content.push({ type: "tool_result", tool_use_id: id, content: "Done." });
    }
    this.pendingToolUseIds = [];
    const text = input.kind === "user" ? input.text : input.note;
    if (text) content.push({ type: "text", text });
    this.messages.push({ role: "user", content });

    const params: BetaMessageCreateParamsNonStreaming = {
      model: this.settings.model,
      max_tokens: 16000,
      system: this.system,
      tools: this.tools.map((t): BetaTool => ({ ...t, strict: true })),
      messages: this.messages,
      // Caches the growing conversation; the system blocks carry their own breakpoint.
      cache_control: { type: "ephemeral" },
      ...(this.settings.effort ? { output_config: { effort: this.settings.effort } } : {}),
      ...(useRefusalFallback(this.settings) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };

    let response;
    try {
      response = await this.client.beta.messages.create(params);
    } catch (err) {
      this.messages.pop(); // keep history valid so the user can retry
      throw new EngineError(describeApiError(err));
    }
    // Append the assistant turn unchanged (thinking blocks included) so history stays append-only.
    this.messages.push({ role: "assistant", content: response.content as BetaContentBlockParam[] });

    if (response.stop_reason === "refusal") {
      throw new EngineError(
        `Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}. Try rephrasing it.`,
      );
    }
    if (response.stop_reason === "max_tokens") throw new EngineError("The response hit the token limit. Try a narrower question.");

    const text_ = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    const toolUses = response.content.flatMap((b) => (b.type === "tool_use" ? [b] : []));
    this.pendingToolUseIds = toolUses.map((t) => t.id);

    const submit = toolUses.find((t) => t.name === "submit_query");
    if (submit) {
      const inp = submit.input as { query?: string; explanation?: string };
      return { kind: "done", text: text_, submitted: { query: String(inp.query ?? ""), explanation: String(inp.explanation ?? "") } };
    }
    if (toolUses.length) {
      return { kind: "tools", calls: toolUses.map((t) => ({ id: t.id, name: t.name, input: (t.input ?? {}) as Record<string, unknown> })) };
    }
    return { kind: "done", text: text_, submitted: null };
  }
}

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Authentication failed: check the API key or gateway token in the options.";
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Not found (check the model name and gateway URL): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
