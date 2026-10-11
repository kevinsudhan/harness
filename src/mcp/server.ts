/**
 * A composed business as an MCP server — the tools in tools.ts, served at POST /mcp.
 *
 * The wire format is the one ArmorIQ's proxy and SDK expect (docs: "MCP Format
 * Requirements"): JSON-RPC 2.0 over HTTP POST, every response wrapped as a server-sent
 * event (`event: message\ndata: {…}\n\n`), tool results as JSON text in a `content` array.
 * initialize, tools/list and tools/call are answered; notifications get 202.
 *
 * It is mounted inside the running app, not beside it: one process, one engine, one set of
 * data files. Two processes writing the same JSON store would each keep a stale copy and
 * overwrite the other's rows.
 *
 * Every call goes through the same ModuleEngine a person's click does — the same legality,
 * guards, approvals and ledger. An agent is not trusted more than the desk: a held action
 * comes back "held", in the same approvals queue, for a person to decide.
 *
 * Auth fails closed. A bearer token is required on every request, compared in constant
 * time; the token is made on first start and kept beside the build (.mcp-secret), so only
 * someone who can read the build folder — or ArmorIQ, given it at registration — can call.
 */
import type { Request, Response } from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppManifest } from "../builder/appManifest.js";
import type { Row } from "../app-runtime/store.js";
import { EngineError } from "../app-runtime/engine.js";
import { StoreError } from "../app-runtime/store.js";
import type { ModuleEngine } from "../modules/engine.js";
import { toolsFor, type Tool } from "./tools.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The build's MCP token, made on first use. */
export function mcpSecret(buildDir: string): string {
  const file = join(buildDir, ".mcp-secret");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(file, "utf-8").trim();
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

class ToolError extends Error {}

/** Who the ledger says acted. An agent names itself; it is never mistaken for a person at the desk. */
export const agentActor = (name: string | undefined) => `${String(name ?? "").replace(/[^\w .@-]/g, "").trim().slice(0, 40) || "agent"} (agent)`;

/**
 * The MCP server's dispatcher, apart from its transport: the HTTP handler below wraps it,
 * and an agent run started from the app's own page calls it in-process — the same tools,
 * the same answers, one code path.
 */
export function mcpServer(app: AppManifest, engine: ModuleEngine) {
  const tools = toolsFor(app);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const serverName = `${app.business.name} (${app.vertical.label})`;

  const compact = (entityName: string, r: Row) => {
    const e = engine.entity(entityName);
    const d = engine.decorate(e, r);
    const out: Record<string, unknown> = { id: r.id, title: r[e.title] ?? null };
    if (e.lifecycle) out.stage = d._state ?? null;
    for (const c of e.columns) {
      if (c.pk || c.name === e.title || c.name === e.stageColumn || c.name === "created_at" || c.name === "updated_at") continue;
      const v = r[c.name];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      out[c.name] = c.links ? `${v} (${(d._labels as Record<string, string>)[c.name] ?? v})` : v;
    }
    return out;
  };

  function run(tool: Tool, args: Record<string, unknown>, by: string): unknown {
    if (tool.name === "find_records") {
      const e = engine.entity(String(args.entity ?? ""));
      const q = String(args.query ?? "").toLowerCase().trim();
      const stage = String(args.stage ?? "");
      let rows = engine.store.rows(e).map((r) => engine.decorate(e, r));
      if (q) rows = rows.filter((r) => Object.values(r).some((v) => v != null && typeof v !== "object" && String(v).toLowerCase().includes(q)) || Object.values(r._labels as Record<string, string>).some((v) => v.toLowerCase().includes(q)));
      if (stage) rows = rows.filter((r) => r._state === stage);
      const found = rows.reverse();
      return { entity: e.name, count: found.length, records: found.slice(0, 20).map((r) => compact(e.name, r)) };
    }
    if (tool.name === "get_record") {
      const e = engine.entity(String(args.entity ?? ""));
      const id = String(args.id ?? "");
      const row = engine.store.get(e, id);
      if (!row) throw new ToolError(`there is no ${(e.singular ?? e.label).toLowerCase()} ${id}`);
      const o = engine.options(e.name, id);
      const related = app.entities.flatMap((other) =>
        other.columns.filter((c) => c.links === e.name).map((c) => ({ entity: other.name, ids: engine.store.rows(other).filter((r) => String(r[c.name]) === id).map((r) => r.id) })),
      ).filter((r) => r.ids.length);
      return {
        record: compact(e.name, row),
        stage: o.state ? { state: o.state, label: o.label, unmet_requirements: o.unmet } : null,
        actions_now: o.actions.map((a) => ({ tool: a.action, label: a.label, needs_approval: a.verdict.autonomy === "approve" ? `${a.verdict.approver}: ${a.verdict.why}` : false })),
        waiting_for_approval: o.pendingApprovals.map((p) => ({ action: p.action, approver: p.approver, why: p.why })),
        related,
      };
    }
    if (tool.kind === "create") {
      const row = engine.create(tool.entity!, args, by);
      return { created: { entity: tool.entity, id: row.id }, record: compact(tool.entity!, row) };
    }
    const { id, ...params } = args;
    if (!id) throw new ToolError(`${tool.name} needs the id of the record it acts on`);
    const r = engine.act(tool.entity!, String(id), tool.name, params, by);
    return {
      outcome: r.outcome,
      summary: r.entry.summary,
      stage: engine.stateOf(tool.entity!, String(id)),
      ...(r.created ? { created: r.created } : {}),
      ...(r.approval ? { approval: { id: r.approval.id, approver: r.approval.approver, why: r.approval.why, note: "held for a person in the app's approvals queue — do not retry" } } : {}),
    };
  }

  function answer(msg: Rpc, by: string): unknown {
    const id = msg.id ?? null;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        const asked = String(msg.params?.protocolVersion ?? "");
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: "1.0.0" },
          instructions: `Tools for running ${app.business.name}. Look records up with find_records and get_record before acting; act with the action tools, which follow the business's own stages and approval rules.`,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = byName.get(name);
        if (!tool) return fail(-32602, `no tool "${name}"`);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const out = run(tool, args, by);
          return ok({ content: [{ type: "text", text: JSON.stringify(out) }], isError: false });
        } catch (e) {
          if (e instanceof EngineError || e instanceof StoreError || e instanceof ToolError) {
            // A refusal of the input is the tool's answer, not a protocol failure: the model reads it and adjusts.
            return ok({ content: [{ type: "text", text: JSON.stringify({ error: e.message }) }], isError: true });
          }
          throw e;
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  return { tools, answer };
}

export function mcpHandler(app: AppManifest, engine: ModuleEngine, secret: string) {
  const { answer } = mcpServer(app, engine);
  const authorised = (req: Request) => {
    const given = Buffer.from(String(req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(secret);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  return (req: Request, res: Response) => {
    if (!authorised(req)) return void res.status(401).json({ error: "a valid bearer token is required" });
    const msg = req.body as Rpc;
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return void res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one JSON-RPC 2.0 request per POST" } });
    }
    // A notification has no id and wants no answer.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method.startsWith("notifications/")) return void res.status(202).end();
    }
    let out: unknown;
    try {
      out = answer(msg, agentActor(req.header("x-agent-name")));
    } catch (e) {
      console.error(`[mcp] ${msg.method} — ${e instanceof Error ? e.message : String(e)}`);
      out = { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: "internal error" } };
    }
    res.status(200).setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
  };
}

/**
 * The tools as an agent sees them, called in-process — for an agent run started from the
 * app itself. Same dispatcher as POST /mcp, minus the transport and its token: the caller
 * is the app's own server, already behind its access guard.
 */
export function inProcessTools(server: ReturnType<typeof mcpServer>, agentName: string) {
  const by = agentActor(agentName);
  let id = 0;
  const call = (method: string, params?: Record<string, unknown>) => {
    const out = server.answer({ jsonrpc: "2.0", id: ++id, method, params }, by) as { result?: unknown; error?: { message: string } };
    if (out.error) throw new Error(`${method}: ${out.error.message}`);
    return out.result;
  };
  return {
    async listTools() {
      return (call("tools/list") as { tools: Array<{ name: string; description: string; inputSchema: Tool["inputSchema"] }> }).tools;
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const r = call("tools/call", { name, arguments: args }) as { content: Array<{ text: string }>; isError: boolean };
      const text = r.content.map((c) => c.text).join("\n");
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { /* plain text */ }
      return { data, isError: r.isError };
    },
  };
}
