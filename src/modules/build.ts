/**
 * A composition, written to disk as a build the app runtime can serve.
 *
 *   builds/<id>-<hash>/
 *     config.json   what the model (or a person) wrote — the one file to edit
 *     app.json      the composed app the runtime reads — regenerated, never edited
 *     schema.sql    the same tables for a Postgres the business does not have yet
 *     BUILD.md      the business in prose: modules, stages, what waits for whom
 *     armoriq/      the agent's ArmorIQ policy (policy.yaml, armoriq.yaml, AGENT-RULES.md)
 *
 * Same rule as the fork builder: writing a build touches only its own folder. Nothing
 * reaches a database, a phone line or a workflow instance.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BusinessConfig } from "./config.js";
import type { ComposedApp, Composition } from "./compose.js";
import { toAppManifest } from "./manifest.js";
import { agentPolicy } from "../agent/policy.js";
import type { PolicyDefault } from "./types.js";

function money(app: ComposedApp, n: number) {
  return `${app.business.currencySymbol}${n.toLocaleString(app.business.locale)}`;
}

export function policyLine(app: ComposedApp, p: PolicyDefault): string {
  if (p.mode === "auto") return "acts alone";
  if (p.mode === "approve") return `always waits for ${p.approver} — ${p.why}`;
  const figure = p.measure === "amount" ? money(app, p.limit) : `${p.limit}%`;
  return `waits for ${p.approver} ${p.trigger === "atOrAbove" ? "at or above" : "beyond"} ${figure}`;
}

export function schemaSql(app: ComposedApp): string {
  const out = [`-- ${app.business.name} (${app.label}) — composed from the module catalogue. Generated; edit config.json instead.`, ""];
  for (const e of app.entities) {
    const cols = [
      "  id text primary key",
      ...e.fields.map((f) => `  ${f.name} ${f.storage}${f.required && !f.formula ? " not null" : ""}${f.type === "ref" ? ` references ${f.ref}(id)` : ""}${f.formula ? ` -- computed: ${f.formula}` : ""}`),
      ...(e.lifecycle ? [`  stage text not null default '${e.lifecycle.initial}'`] : []),
      "  created_at timestamp with time zone default now()",
      "  updated_at timestamp with time zone default now()",
    ];
    out.push(`-- ${e.label}: ${e.purpose} (${e.module})`, `create table ${e.name} (`, cols.join(",\n"), ");", "");
  }
  return out.join("\n");
}

export function buildDoc(c: Composition, request?: string): string {
  const app = c.app!;
  const lines = [
    `# ${app.business.name}`,
    "",
    `${app.label}, composed from ${app.modules.length} modules of the catalogue.${request ? ` Asked for as: "${request}".` : ""}`,
    "",
    "To change it, edit `config.json` and compose again — nothing here is hand-edited:",
    "",
    "```bash",
    "npm run compose -- --config builds/<this folder>/config.json",
    "```",
    "",
    "## Modules",
    "",
    ...app.modules.map((m) => `- **${m.label}** (\`${m.id}\`) — ${m.entities.map((n) => app.entities.find((e) => e.name === n)?.label ?? n).join(", ")}`),
    "",
    "## Stages",
    "",
  ];
  for (const e of app.entities.filter((x) => x.lifecycle)) {
    const lc = e.lifecycle!;
    lines.push(`- **${e.label}**${e.name === app.primary ? " (the board)" : ""}: ${lc.order.map((s) => lc.states[s].label).join(" → ")}`);
  }
  lines.push("", "## What waits for a person", "");
  const held = app.actions.filter((a) => a.policy.mode !== "auto");
  for (const a of held) lines.push(`- **${a.label}** on ${app.entities.find((e) => e.name === a.entity)?.label.toLowerCase()} — ${policyLine(app, a.policy)}`);
  if (!held.length) lines.push("- Nothing: every action acts alone.");
  if (app.actions.some((a) => a.custom)) {
    lines.push("", "## The business's own actions", "");
    for (const a of app.actions.filter((x) => x.custom)) lines.push(`- \`${a.name}\` — ${a.summary} (${a.when?.join(", ") ?? "any stage"}${a.to ? ` → ${a.to}` : ""})`);
  }
  if (app.openQuestions.length) {
    lines.push("", "## Open questions", "");
    for (const q of app.openQuestions) lines.push(`- ${q.question} _(${q.blocks})_`);
  }
  if (c.notes.length) {
    lines.push("", "## What composing changed", "");
    for (const n of c.notes) lines.push(`- ${n}`);
  }
  lines.push("", "## Run it", "", "```bash", "npm run app -- <this folder's name>", "```", "");
  return lines.join("\n");
}

/** Writes the build. Returns its folder, relative to the repo root. */
export function writeBuild(c: Composition, repoRoot: string, request?: string): string {
  if (!c.app || !c.config) throw new Error(`cannot write a build with problems:\n  - ${c.problems.join("\n  - ")}`);
  const config: BusinessConfig = c.config;
  const json = JSON.stringify(config, null, 2);
  const tag = createHash("sha1").update(json).digest("hex").slice(0, 6);
  const rel = join("builds", `${c.app.id}-${tag}`);
  const dir = resolve(repoRoot, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), json + "\n");
  const manifest = toAppManifest(c.app);
  writeFileSync(join(dir, "app.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "schema.sql"), schemaSql(c.app));
  writeFileSync(join(dir, "BUILD.md"), buildDoc(c, request));
  // The agent's ArmorIQ policy, compiled from the same modules (src/agent/policy.ts).
  const policy = agentPolicy(manifest);
  mkdirSync(join(dir, "armoriq"), { recursive: true });
  writeFileSync(join(dir, "armoriq", "policy.yaml"), policy.policyYaml);
  writeFileSync(join(dir, "armoriq", "armoriq.yaml"), policy.armoriqYaml);
  writeFileSync(join(dir, "armoriq", "AGENT-RULES.md"), policy.rulesMd);
  return rel.replace(/\\/g, "/");
}
