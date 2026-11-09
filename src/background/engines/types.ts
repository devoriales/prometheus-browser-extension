export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type EngineInput =
  | { kind: "user"; text: string }
  /** Results for every pending tool call; `note` is appended as extra user text (e.g. "out of tool rounds"). */
  | { kind: "toolResults"; results: ToolResult[]; note?: string };

export type EngineStep =
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "done"; text: string; submitted: { query: string; explanation: string } | null };

/** A conversation with Claude. Each instance keeps its own history. */
export interface Engine {
  send(input: EngineInput): Promise<EngineStep>;
}

export class EngineError extends Error {}
