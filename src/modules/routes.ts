/**
 * The HTTP surface of a composed app — the same shape the shell already reads, made
 * entity-aware: any record with stages has a lifecycle and actions, not just the primary.
 *
 *   GET   /api/overview                      counts, the board's stages, what is waiting
 *   GET   /api/e/:entity                     rows, with their stage and their links' names
 *   GET   /api/e/:entity/:id                 a record, what points at it, its stages and actions
 *   POST  /api/e/:entity                     create          PATCH /api/e/:entity/:id   edit
 *   POST  /api/e/:entity/:id/act             { action, params } — performed, held or refused
 *   POST  /api/e/:entity/:id/advance         { to, why, force } — the pipeline only
 *   POST  /api/e/:entity/:id/requirements    { requirement, met }
 *   GET   /api/approvals   POST /api/approvals/:id { approve }
 *   GET   /api/ledger      POST /api/sample     POST /api/sweep
 *
 * The /api/records/:id/* routes the shell's stage components call are kept, on the primary.
 * Every write carries the desk user's name, as before; the ledger has no anonymous entry.
 */
import type { Express, Request, Response } from "express";
import type { AppEntity, AppManifest } from "../builder/appManifest.js";
import type { Row, Store } from "../app-runtime/store.js";
import { ModuleEngine } from "./engine.js";
import { EngineError } from "../app-runtime/engine.js";
import { seedComposed } from "./seed.js";
import { mcpHandler, mcpSecret } from "../mcp/server.js";
import { mountAgent } from "../agent/routes.js";

interface Deps {
  app: AppManifest;
  store: Store;
  wrap: (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => void;
  param: (req: Request, name: string) => string;
  actor: (req: Request) => string;
  /** The build folder, where the MCP token is kept. */
  buildDir: string;
}

export function mountComposed(server: Express, { app, store, wrap, param, actor, buildDir }: Deps): ModuleEngine {
  const engine = new ModuleEngine(app, store);

  // Time moves records on its own — invoices fall overdue, memberships lapse. Swept at start
  // and every five minutes; a person can also ask (/api/sweep).
  engine.sweep();
  setInterval(() => {
    try { engine.sweep(); } catch (e) { console.error(`[sweep] ${e instanceof Error ? e.message : String(e)}`); }
  }, 5 * 60_000).unref();

  const entityOf = (name: string): AppEntity | undefined => app.entities.find((e) => e.name === name);
  const decorate = (e: AppEntity, r: Row) => engine.decorate(e, r);

  server.get("/api/overview", wrap(() => {
    const p = engine.primary;
    const rows = store.rows(p);
    const byState = Object.fromEntries((p.lifecycle?.order ?? []).map((s) => [s, 0]));
    for (const r of rows) {
      const s = engine.stateOf(p.name, String(r.id));
      if (s && s in byState) byState[s]++;
    }
    const ledger = engine.ledger();
    const today = new Date().toISOString().slice(0, 10);
    return {
      counts: Object.fromEntries(app.entities.map((e) => [e.name, store.rows(e).length])),
      byState,
      pendingApprovals: engine.approvals().filter((a) => a.status === "pending").length,
      actionsToday: ledger.filter((l) => l.at.startsWith(today) && (l.kind === "action" || l.kind === "approved" || l.kind === "advanced")).length,
      recent: ledger.slice(-8).reverse(),
      newest: rows.slice(-5).reverse().map((r) => decorate(p, r)),
    };
  }));

  server.get("/api/e/:entity", wrap((req) => {
    const e = engine.entity(param(req, "entity"));
    const q = String(req.query.q ?? "").toLowerCase().trim();
    const stage = String(req.query.stage ?? "");
    let rows = store.rows(e).map((r) => decorate(e, r));
    if (q) rows = rows.filter((r) => Object.values(r).some((v) => v != null && typeof v !== "object" && String(v).toLowerCase().includes(q)) || Object.values(r._labels as Record<string, string>).some((v) => v.toLowerCase().includes(q)));
    if (stage) rows = rows.filter((r) => r._state === stage);
    return rows.reverse();
  }));

  server.get("/api/e/:entity/:id", wrap((req) => {
    const e = engine.entity(param(req, "entity"));
    const id = param(req, "id");
    const row = store.get(e, id);
    if (!row) throw new EngineError(`no ${(e.singular ?? e.label).toLowerCase()} ${id}`);
    const related = app.entities.flatMap((other) =>
      other.columns
        .filter((c) => c.links === e.name)
        .map((c) => ({ entity: other.name, label: other.label, column: c.name, rows: store.rows(other).filter((r) => String(r[c.name]) === id).map((r) => decorate(other, r)) })),
    );
    return {
      row: decorate(e, row),
      related,
      lifecycle: engine.options(e.name, id),
      activity: engine.ledger().filter((l) => l.entity === e.name && l.recordId === id).reverse(),
    };
  }));

  server.post("/api/e/:entity", wrap((req, res) => {
    const row = engine.create(param(req, "entity"), req.body?.values ?? {}, actor(req));
    res.status(201).json(row);
  }));

  server.patch("/api/e/:entity/:id", wrap((req) => engine.update(param(req, "entity"), param(req, "id"), req.body?.values ?? {}, actor(req))));

  const act = (entity: string, id: string, req: Request) => {
    const b = req.body ?? {};
    // The shell's original panel sends amount/discountPct/note beside the action, not in params.
    const params = (b.params as Record<string, unknown> | undefined) ?? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "action" && k !== "by"));
    const result = engine.act(entity, id, String(b.action ?? ""), params, actor(req));
    return { ...result, options: engine.options(entity, id) };
  };
  const advance = (entity: string, id: string, req: Request) => {
    engine.advance(entity, id, String(req.body?.to ?? ""), String(req.body?.why ?? ""), req.body?.force === true, actor(req));
    return engine.options(entity, id);
  };
  const requirement = (entity: string, id: string, req: Request) => {
    engine.setRequirement(entity, id, String(req.body?.requirement ?? ""), req.body?.met !== false, actor(req));
    return engine.options(entity, id);
  };

  server.post("/api/e/:entity/:id/act", wrap((req) => act(param(req, "entity"), param(req, "id"), req)));
  server.post("/api/e/:entity/:id/advance", wrap((req) => advance(param(req, "entity"), param(req, "id"), req)));
  server.post("/api/e/:entity/:id/requirements", wrap((req) => requirement(param(req, "entity"), param(req, "id"), req)));
  server.post("/api/records/:id/act", wrap((req) => act(engine.primary.name, param(req, "id"), req)));
  server.post("/api/records/:id/advance", wrap((req) => advance(engine.primary.name, param(req, "id"), req)));
  server.post("/api/records/:id/requirements", wrap((req) => requirement(engine.primary.name, param(req, "id"), req)));

  server.get("/api/approvals", wrap(() =>
    engine.approvals().slice().reverse().map((a) => {
      const e = entityOf(a.entity);
      const row = e ? store.get(e, a.recordId) : undefined;
      return {
        ...a,
        entityLabel: e?.singular ?? a.entity,
        actionLabel: app.actions?.find((x) => x.name === a.action)?.label ?? a.action,
        title: row && e ? String(row[e.title] ?? a.recordId) : a.recordId,
      };
    }),
  ));
  server.post("/api/approvals/:id", wrap((req) => engine.decideApproval(param(req, "id"), req.body?.approve === true, actor(req))));

  server.get("/api/ledger", wrap((req) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    return engine.ledger().slice(-limit).reverse();
  }));

  server.post("/api/sample", wrap((req) => seedComposed(app, engine, actor(req))));
  server.post("/api/sweep", wrap((req) => { actor(req); return engine.sweep(); }));
  server.get("/api/deployment", wrap(() => ({ deployed: false, deployedAt: null, appUrl: null, memory: null, knowledge: null, agents: [], workflows: [], n8nBase: null })));

  // The same business, as tools for an agent (src/mcp/). Bearer-token only — no desk name, no cookie.
  server.post("/mcp", mcpHandler(app, engine, mcpSecret(buildDir)));
  server.get("/mcp", (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "this MCP server answers POST only" }));
  // …and the agent that uses those tools, run from the app's own Agent page (src/agent/).
  mountAgent(server, { app, engine, buildDir, actor });

  return engine;
}
