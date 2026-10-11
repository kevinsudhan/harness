/**
 * The agent, from inside the app: a person at the desk gives it a task, and watches what
 * it did — which calls ran, which ArmorIQ blocked or held, which the business refused.
 *
 *   GET  /api/agent              is ArmorIQ configured, which model, what the policy allows, past runs
 *   GET  /api/agent/runs/:file   one run, in full
 *   POST /api/agent/run          { task, context?, unguarded? } — run it now
 *
 * The run uses the MCP server's dispatcher in-process (mcp/server.ts), so it meets the same
 * tools, the same kernel and the same ledger as an agent calling /mcp from outside. Runs
 * are saved beside the build (agent-runs/*.json), the same files the CLI writes.
 *
 * Fail closed, as on the command line: without ARMORIQ_API_KEY a run is refused unless the
 * person asks for an unguarded run in so many words, and the run says so on every line.
 */
import type { Express, Request, Response } from "express";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppManifest } from "../builder/appManifest.js";
import type { ModuleEngine } from "../modules/engine.js";
import { complete } from "../builder/router.js";
import { mcpServer, inProcessTools } from "../mcp/server.js";
import { runAgent, type AgentRun } from "./agent.js";
import { ArmorIQGuard, UnguardedGuard, type Guard } from "./guard.js";
import { agentPolicy } from "./policy.js";

interface Deps {
  app: AppManifest;
  engine: ModuleEngine;
  buildDir: string;
  actor: (req: Request) => string;
}

const FILE = /^[\w-]+\.json$/;

export function mountAgent(server: Express, { app, engine, buildDir, actor }: Deps): void {
  const mcp = mcpServer(app, engine);
  const ids = () => agentPolicy(app, { mcpId: process.env.ARMORIQ_MCP_ID, agentId: process.env.ARMORIQ_AGENT_ID, userId: process.env.ARMORIQ_USER_ID });
  const runsDir = join(buildDir, "agent-runs");
  let busy = false;

  const summaries = () => {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .filter((f) => FILE.test(f))
      .sort()
      .reverse()
      .slice(0, 30)
      .map((file) => {
        try {
          const r = JSON.parse(readFileSync(join(runsDir, file), "utf-8")) as AgentRun & { at: string };
          const steps = r.turns.flatMap((t) => t.steps);
          const count = (o: string) => steps.filter((s) => s.outcome === o).length;
          return {
            file,
            at: r.at,
            task: r.task,
            guard: r.guard,
            enforcing: r.enforcing,
            answer: r.answer,
            stoppedBecause: r.stoppedBecause,
            calls: steps.length,
            blocked: count("blocked"),
            held: count("held") + count("held_by_guard"),
            refused: count("refused"),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  server.get("/api/agent", (_req: Request, res: Response) => {
    const p = ids();
    res.json({
      armoriq: Boolean(process.env.ARMORIQ_API_KEY),
      model: process.env.KILO_API_KEY ? "kilo" : process.env.BUILDER_GATEWAY ?? "omniroute",
      agentId: p.agentId,
      mcpId: p.mcpId,
      allowed: p.allow.length,
      blocked: p.block,
      busy,
      runs: summaries(),
    });
  });

  server.get("/api/agent/runs/:file", (req: Request, res: Response) => {
    const file = String(req.params.file ?? "");
    if (!FILE.test(file) || !existsSync(join(runsDir, file))) return void res.status(404).json({ error: "no such run" });
    res.type("json").send(readFileSync(join(runsDir, file), "utf-8"));
  });

  server.post("/api/agent/run", async (req: Request, res: Response) => {
    let by: string;
    try {
      by = actor(req);
    } catch (e) {
      return void res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
    const task = String(req.body?.task ?? "").trim().slice(0, 2000);
    const context = String(req.body?.context ?? "").trim().slice(0, 20000);
    if (task.length < 5) return void res.status(400).json({ error: "say what the agent should do" });
    if (busy) return void res.status(409).json({ error: "the agent is already working on a task — wait for it to finish" });

    const p = ids();
    let guard: Guard;
    if (process.env.ARMORIQ_API_KEY) {
      guard = new ArmorIQGuard({ apiKey: process.env.ARMORIQ_API_KEY, agentId: p.agentId, userId: p.userId, userEmail: process.env.ARMORIQ_USER_EMAIL, mcpName: p.mcpId, llm: "kilo" });
    } else if (req.body?.unguarded === true) {
      guard = new UnguardedGuard();
    } else {
      return void res.status(400).json({ error: "ArmorIQ is not configured (ARMORIQ_API_KEY), so nothing would check the agent's calls. Run it unguarded only if you mean to." });
    }

    busy = true;
    try {
      const agentName = `agent for ${by}`;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: app.business.timezone }).format(new Date());
      const run = await runAgent({
        task,
        context: context ? { source: "pasted by the desk", text: context } : undefined,
        tools: inProcessTools(mcp, agentName),
        guard,
        complete,
        business: { name: app.business.name, label: app.vertical.label, today, currency: app.business.currency },
        maxTurns: 6,
      });
      mkdirSync(runsDir, { recursive: true });
      const at = new Date().toISOString();
      const file = `${at.replace(/[:.]/g, "-")}.json`;
      writeFileSync(join(runsDir, file), JSON.stringify({ at, url: "in-process", agent: agentName, askedBy: by, ...run }, null, 2));
      res.json({ file, run: { ...run, at } });
    } catch (e) {
      res.status(502).json({ error: `the agent stopped: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      busy = false;
    }
  });
}
