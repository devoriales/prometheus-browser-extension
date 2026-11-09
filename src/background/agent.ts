// One chat session per open panel (per Port). Runs the tool loop: the engine
// asks for tools, the content script executes them against Prometheus, and the
// results go back to the engine until Claude submits a query or replies.

import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { BASE_INSTRUCTIONS, describeToolCall, environmentBlock, toolSpecs, userMessage } from "../shared/prompt";
import type { AskContext, ToBackground, ToContent } from "../shared/protocol";
import { loadSecrets, loadSettings, type Settings } from "../shared/settings";
import { AnthropicEngine, createClient } from "./engines/anthropic";
import { ClaudeCodeEngine } from "./engines/claudeCode";
import { EngineError, type Engine, type EngineStep, type ToolCall, type ToolResult } from "./engines/types";

const TOOL_TIMEOUT_MS = 90_000;

export class ChatSession {
  private engine: Engine | null = null;
  private engineKey = "";
  private busy = false;
  private readonly pendingTools = new Map<string, (r: ToolResult) => void>();
  private disconnected = false;

  constructor(private readonly port: chrome.runtime.Port) {
    port.onMessage.addListener((msg: ToBackground) => void this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      this.disconnected = true;
      for (const [id, resolve] of this.pendingTools) resolve({ id, content: "Panel closed.", isError: true });
      this.pendingTools.clear();
    });
  }

  private post(msg: ToContent): void {
    if (!this.disconnected) this.port.postMessage(msg);
  }

  private async onMessage(msg: ToBackground): Promise<void> {
    switch (msg.type) {
      case "ping":
        return; // keeps the service worker alive during long requests
      case "reset":
        this.engine = null;
        return;
      case "toolResult":
        this.pendingTools.get(msg.callId)?.({ id: msg.callId, content: msg.content, isError: msg.isError });
        this.pendingTools.delete(msg.callId);
        return;
      case "ask":
        if (this.busy) return this.post({ type: "error", message: "Still working on the previous question." });
        this.busy = true;
        try {
          await this.ask(msg.text, msg.context);
        } catch (err) {
          this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          this.busy = false;
        }
    }
  }

  private async ask(text: string, ctx: AskContext): Promise<void> {
    const settings = await loadSettings();
    const engine = await this.getEngine(settings, ctx);
    this.post({ type: "progress", text: "Thinking…" });

    let step: EngineStep = await engine.send({ kind: "user", text: userMessage(text, ctx) });
    let rounds = 0;
    while (step.kind === "tools") {
      if (rounds > settings.maxToolRounds) {
        throw new EngineError(`Claude did not finish within ${settings.maxToolRounds} lookup rounds. Try a more specific question.`);
      }
      const results = await Promise.all(step.calls.map((c) => this.runTool(c)));
      rounds++;
      const note =
        rounds === settings.maxToolRounds
          ? "You have used all lookup rounds. Submit your best query now (or reply in text if you cannot)."
          : undefined;
      this.post({ type: "progress", text: "Thinking…" });
      step = await engine.send({ kind: "toolResults", results, note });
    }

    if (step.submitted) {
      const explanation = [step.text, step.submitted.explanation].filter(Boolean).join("\n\n");
      this.post({ type: "answer", text: explanation, query: step.submitted.query.trim() });
    } else {
      this.post({ type: "answer", text: step.text || "(No answer.)", query: null });
    }
  }

  /** Reuse the conversation while the provider/model/instance stays the same; otherwise start fresh. */
  private async getEngine(settings: Settings, ctx: AskContext): Promise<Engine> {
    const key = JSON.stringify([settings.provider, settings.model, settings.claudeCodeModel, ctx.instanceId, ctx.validation]);
    if (this.engine && key === this.engineKey) return this.engine;

    const instance = settings.instances.find((i) => i.id === ctx.instanceId);
    const tools = toolSpecs(ctx.validation);
    const env = environmentBlock(settings, instance, ctx);
    if (settings.provider === "claude-code") {
      this.engine = new ClaudeCodeEngine(settings, [BASE_INSTRUCTIONS, env], tools);
    } else {
      const client = createClient(settings, await loadSecrets());
      const system: BetaTextBlockParam[] = [
        { type: "text", text: BASE_INSTRUCTIONS },
        // Breakpoint after the (possibly large) metric list so later questions reuse it from cache.
        { type: "text", text: env, cache_control: { type: "ephemeral" } },
      ];
      this.engine = new AnthropicEngine(client, settings, system, tools);
    }
    this.engineKey = key;
    return this.engine;
  }

  private runTool(call: ToolCall): Promise<ToolResult> {
    this.post({ type: "progress", text: describeToolCall(call.name, call.input) });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTools.delete(call.id);
        resolve({ id: call.id, content: "Tool timed out.", isError: true });
      }, TOOL_TIMEOUT_MS);
      this.pendingTools.set(call.id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post({ type: "toolCall", callId: call.id, name: call.name, input: call.input });
    });
  }
}
