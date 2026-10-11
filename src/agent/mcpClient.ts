/**
 * The agent's side of MCP: JSON-RPC over HTTP POST, reading the answer whether the server
 * sends it as plain JSON or as a server-sent event (ours, and ArmorIQ's format, use SSE).
 *
 * Deliberately small — initialize, tools/list, tools/call — because that is all the agent
 * needs, and every extra method is one more thing an injected instruction could reach for.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] };
}

export interface McpCallResult {
  /** The tool's answer, parsed from its JSON text when it is JSON. */
  data: unknown;
  isError: boolean;
}

export class McpError extends Error {}

export class McpClient {
  private nextId = 1;
  constructor(private url: string, private token: string, private agentName = "agent") {}

  private async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const r = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.token}`,
        "x-agent-name": this.agentName,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (!r.ok) throw new McpError(`${method}: HTTP ${r.status} ${text.slice(0, 200)}`);
    const body = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text;
    const msg = JSON.parse(body) as { result?: unknown; error?: { message?: string } };
    if (msg.error) throw new McpError(`${method}: ${msg.error.message ?? "error"}`);
    return msg.result;
  }

  async initialize(): Promise<{ serverInfo?: { name?: string }; instructions?: string }> {
    return (await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness-agent", version: "1.0.0" } })) as { serverInfo?: { name?: string }; instructions?: string };
  }

  async listTools(): Promise<McpTool[]> {
    return ((await this.rpc("tools/list")) as { tools: McpTool[] }).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const r = (await this.rpc("tools/call", { name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* plain text */ }
    return { data, isError: r.isError === true };
  }
}
