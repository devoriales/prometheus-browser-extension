// Engine that uses the user's own Claude Code installation (and therefore their
// Claude Pro/Max/Ultra subscription login) through a Chrome native messaging
// host. The extension never sees subscription credentials: it only sends the
// prompt to the local bridge, which runs `claude -p` with all tools disabled.
//
// Claude Code print mode has no client-side tools, so tools are expressed as a
// JSON action protocol (one action per turn, enforced with --json-schema) and
// the conversation continues with --resume.

import { ACTION_SCHEMA, actionProtocolInstructions, type ToolSpec } from "../../shared/prompt";
import type { Settings } from "../../shared/settings";
import { EngineError, type Engine, type EngineInput, type EngineStep } from "./types";

export const NATIVE_HOST = "com.promql_ai.claude_bridge";

export interface BridgeRunRequest {
  type: "run";
  prompt: string;
  systemPrompt: string;
  schema: object;
  model: string;
  effort: string;
  sessionId: string | null;
  forceSubscription: boolean;
}

export interface BridgeResponse {
  ok: boolean;
  error?: string;
  sessionId?: string;
  structured?: unknown;
  result?: string;
  costUsd?: number;
  version?: string;
}

export function callBridge(message: object): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response?: BridgeResponse) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(
          new EngineError(
            /not found|forbidden/i.test(err.message ?? "")
              ? "The Claude Code bridge is not installed. Run `npm run bridge:install` in the extension folder (see README)."
              : `Claude Code bridge error: ${err.message}`,
          ),
        );
        return;
      }
      if (!response) return reject(new EngineError("Claude Code bridge returned no response."));
      resolve(response);
    });
  });
}

interface Action {
  action: "search_metrics" | "get_metric_labels" | "run_query" | "submit_query" | "reply";
  pattern?: string;
  metric?: string;
  query?: string;
  explanation?: string;
  text?: string;
}

export class ClaudeCodeEngine implements Engine {
  private sessionId: string | null = null;
  private callCounter = 0;
  private readonly systemPrompt: string;

  constructor(
    private readonly settings: Settings,
    systemParts: string[],
    tools: ToolSpec[],
  ) {
    this.systemPrompt = [...systemParts, actionProtocolInstructions(tools)].join("\n\n");
  }

  async send(input: EngineInput): Promise<EngineStep> {
    const prompt =
      input.kind === "user"
        ? input.text
        : [...input.results.map((r) => `Result of ${r.id}${r.isError ? " (error)" : ""}:\n${r.content}`), input.note ?? ""]
            .join("\n\n")
            .trim();

    const response = await callBridge({
      type: "run",
      prompt,
      systemPrompt: this.systemPrompt,
      schema: ACTION_SCHEMA,
      model: this.settings.claudeCodeModel,
      effort: this.settings.effort,
      sessionId: this.sessionId,
      forceSubscription: this.settings.claudeCodeForceSubscription,
    } satisfies BridgeRunRequest);

    if (!response.ok) throw new EngineError(response.error || "Claude Code failed.");
    if (response.sessionId) this.sessionId = response.sessionId;

    const action = parseAction(response.structured ?? response.result);
    switch (action.action) {
      case "submit_query":
        return { kind: "done", text: "", submitted: { query: action.query ?? "", explanation: action.explanation ?? "" } };
      case "reply":
        return { kind: "done", text: action.text ?? "", submitted: null };
      default: {
        const id = `${action.action}#${++this.callCounter}`;
        const { action: name, ...rest } = action;
        return { kind: "tools", calls: [{ id, name, input: rest }] };
      }
    }
  }
}

function parseAction(raw: unknown): Action {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Model answered in plain text despite the schema; show it as a reply.
      return { action: "reply", text: value as string };
    }
  }
  if (value && typeof value === "object" && "action" in value) return value as Action;
  throw new EngineError("Claude Code returned an unexpected response.");
}
