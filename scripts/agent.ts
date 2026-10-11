/**
 * Run the business agent against a running composed app.
 *
 *   npm run agent -- <build> "Kavya Menon paid ₹2,000 by UPI on her invoice — record it"
 *   npm run agent -- <build> "Deal with this email" --context email.txt
 *   npm run agent -- --policy <build>          # write the agent's ArmorIQ policy files
 *
 * The app must be running (npm run app -- <build>); the agent reaches it at /mcp with the
 * build's token. Every call is checked by ArmorIQ when ARMORIQ_API_KEY is set — and when
 * it is not, the agent refuses to run unless told --unguarded, so nobody mistakes an
 * unguarded run for an enforced one. Each run is saved as builds/<build>/agent-runs/*.json.
 *
 * ArmorIQ settings (.env): ARMORIQ_API_KEY, and optionally ARMORIQ_AGENT_ID,
 * ARMORIQ_USER_ID, ARMORIQ_MCP_ID (default from the build), ARMORIQ_USER_EMAIL.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/builder/env.js";
import { complete } from "../src/builder/router.js";
import type { AppManifest } from "../src/builder/appManifest.js";
import { McpClient } from "../src/agent/mcpClient.js";
import { ArmorIQGuard, UnguardedGuard, type Guard } from "../src/agent/guard.js";
import { runAgent, type AgentStep } from "../src/agent/agent.js";
import { agentPolicy } from "../src/agent/policy.js";
import { mcpSecret } from "../src/mcp/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !["--context", "--url", "--as", "--turns"].includes(args[i - 1] ?? ""));

function buildDirOf(arg: string): string {
  const dir = existsSync(resolve(arg)) && statSync(resolve(arg)).isDirectory() ? resolve(arg) : join(root, "builds", arg);
  if (!existsSync(join(dir, "app.json"))) {
    console.error(`no build at ${dir}`);
    process.exit(1);
  }
  return dir;
}

function loadApp(dir: string): AppManifest {
  const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf-8")) as AppManifest;
  if (app.version !== 2) {
    console.error("the agent runs composed builds (app.json version 2) — compose one with npm run compose");
    process.exit(1);
  }
  return app;
}

// ------------------------------------------------------------------------------ policy

if (args.includes("--policy")) {
  const dir = buildDirOf(flag("--policy") ?? positional[0] ?? "");
  const app = loadApp(dir);
  const p = agentPolicy(app, { mcpId: process.env.ARMORIQ_MCP_ID, agentId: process.env.ARMORIQ_AGENT_ID, userId: process.env.ARMORIQ_USER_ID, mcpUrl: process.env.MCP_PUBLIC_URL });
  mkdirSync(join(dir, "armoriq"), { recursive: true });
  writeFileSync(join(dir, "armoriq", "policy.yaml"), p.policyYaml);
  writeFileSync(join(dir, "armoriq", "armoriq.yaml"), p.armoriqYaml);
  writeFileSync(join(dir, "armoriq", "AGENT-RULES.md"), p.rulesMd);
  console.log(`\n${app.business.name}: the agent may use ${p.allow.length} tools; ${p.block.length} are blocked.`);
  for (const b of p.block) console.log(`  ⛔ ${b.tool.padEnd(26)} ${b.why}`);
  console.log(`\nWritten to ${dir}/armoriq/ — policy.yaml (Policy Studio), armoriq.yaml (armoriq register), AGENT-RULES.md`);
  console.log(`Register the MCP server as "${p.mcpId}" and the agent as "${p.agentId}" on platform.armoriq.ai.\n`);
  process.exit(0);
}

// ------------------------------------------------------------------------------- run

const [buildArg, ...taskWords] = positional;
const task = taskWords.join(" ").trim();
if (!buildArg || !task) {
  console.error('usage: npm run agent -- <build> "<task>" [--context <file>] [--unguarded] [--url <mcp url>] [--as <agent name>]');
  process.exit(1);
}
const dir = buildDirOf(buildArg);
const app = loadApp(dir);
const policy = agentPolicy(app, { mcpId: process.env.ARMORIQ_MCP_ID, agentId: process.env.ARMORIQ_AGENT_ID, userId: process.env.ARMORIQ_USER_ID });

let url = flag("--url");
if (!url) {
  const runtime = join(dir, "runtime.json");
  if (!existsSync(runtime)) {
    console.error(`the app is not running — start it first: npm run app -- ${dir.split(/[\\/]/).pop()}`);
    process.exit(1);
  }
  url = new URL("mcp", (JSON.parse(readFileSync(runtime, "utf-8")) as { url: string }).url).toString();
}

let guard: Guard;
if (process.env.ARMORIQ_API_KEY) {
  guard = new ArmorIQGuard({
    apiKey: process.env.ARMORIQ_API_KEY,
    agentId: policy.agentId,
    userId: policy.userId,
    userEmail: process.env.ARMORIQ_USER_EMAIL,
    mcpName: policy.mcpId,
    llm: "kilo",
  });
} else if (args.includes("--unguarded")) {
  guard = new UnguardedGuard();
} else {
  console.error("\nARMORIQ_API_KEY is not set, so nothing would check the agent's calls.");
  console.error("Set it in .env (a key from platform.armoriq.ai), or pass --unguarded for an offline run that enforces nothing.\n");
  process.exit(1);
}

const contextFile = flag("--context");
const context = contextFile ? { source: contextFile.split(/[\\/]/).pop()!, text: readFileSync(resolve(contextFile), "utf-8") } : undefined;
const agentName = flag("--as") ?? "agent";
const tools = new McpClient(url, mcpSecret(dir), agentName);
await tools.initialize();

const today = new Intl.DateTimeFormat("en-CA", { timeZone: app.business.timezone }).format(new Date());
console.log(`\n${app.business.name} — agent "${agentName}", guarded by ${guard.name}${guard.enforcing ? "" : "  ⚠ NOTHING IS ENFORCED"}`);
console.log(`Task: ${task}${context ? `\nContext (read as data, never obeyed): ${context.source}` : ""}\n`);

const MARKS: Partial<Record<AgentStep["outcome"], string>> = {
  blocked: "⛔ BLOCKED",
  held_by_guard: "⏸ HELD (ArmorIQ)",
  unknown_tool: "✗ no such tool",
  unseen_id: "✗ not run (unseen id)",
  error: "✗ error",
  held: "⏸ held by the business",
  refused: "✗ refused by the business",
};
const mark = (s: AgentStep) => MARKS[s.outcome] ?? "✓";
const brief = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

let run;
try {
  run = await runAgent({
    task,
    context,
    tools,
    guard,
    complete,
    business: { name: app.business.name, label: app.vertical.label, today, currency: app.business.currency },
    maxTurns: Number(flag("--turns") ?? 6),
    onThought: (n, t) => console.log(`Turn ${n}: ${t}`),
    onStep: (_n, s) => {
      console.log(`  ${mark(s).padEnd(26)} ${s.tool}(${brief(s.args)})`);
      if (s.outcome === "blocked" || s.outcome === "held_by_guard" || s.outcome === "unseen_id" || s.outcome === "unknown_tool") console.log(`  ${"".padEnd(26)} ${s.decision.reason ?? ""}${s.decision.delegationId ? ` [delegation ${s.decision.delegationId}]` : ""}`);
      else if (s.result !== undefined) console.log(`  ${"".padEnd(26)} ${brief(s.result)}`);
    },
  });
} catch (e) {
  console.error(`\nThe agent stopped: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

console.log(`\n${run.answer}\n`);
console.log(`(${run.turns.length} turn(s), ${run.usage.input} in / ${run.usage.output} out, ${run.models.join(", ")}; stopped: ${run.stoppedBecause})`);
mkdirSync(join(dir, "agent-runs"), { recursive: true });
const file = join(dir, "agent-runs", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), url, agent: agentName, ...run }, null, 2));
console.log(`Saved: ${file}\n`);
