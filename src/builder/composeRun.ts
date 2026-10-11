/**
 * One composition request, from words to a build on disk — the state machine behind the
 * builder page's "New business".
 *
 *   REQUEST_RECEIVED → DRAFTING → CLARIFICATION_REQUIRED
 *                               ↘ WAITING_FOR_APPROVAL → APPROVED → BUILT
 *                               ↘ FAILED (the draft did not compose)
 *
 * Same shape as forkRun.ts on purpose — the page follows both the same way, by polling —
 * with one thing fork mode could not offer: the config itself. A composition is a short
 * JSON a person can read, so the page shows it and lets it be edited, and every edit is
 * composed again on the spot, in code, at zero tokens. A draft that failed to compose can
 * be fixed by hand the same way rather than re-asked of the model.
 *
 * Approval writes builds/<id>-<hash>/ and nothing else, like every build here.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compose, type Composition, type ComposedApp } from "../modules/compose.js";
import { draftComposition, type CompositionDraft, type DraftDeps } from "../modules/draft.js";
import { writeBuild, policyLine } from "../modules/build.js";
import { toAppManifest } from "../modules/manifest.js";
import { agentPolicy } from "../agent/policy.js";
import { CATALOG } from "../modules/catalog/index.js";

export type ComposeState =
  | "REQUEST_RECEIVED"
  | "DRAFTING"
  | "CLARIFICATION_REQUIRED"
  | "WAITING_FOR_APPROVAL"
  | "APPROVED"
  | "BUILT"
  | "REJECTED"
  | "FAILED";

const LEGAL: Record<ComposeState, ComposeState[]> = {
  REQUEST_RECEIVED: ["DRAFTING", "WAITING_FOR_APPROVAL", "FAILED"],
  DRAFTING: ["CLARIFICATION_REQUIRED", "WAITING_FOR_APPROVAL", "FAILED"],
  CLARIFICATION_REQUIRED: ["WAITING_FOR_APPROVAL", "REJECTED", "FAILED"],
  // An edit that breaks the config sends it back to FAILED; fixing it brings it back.
  WAITING_FOR_APPROVAL: ["APPROVED", "REJECTED", "FAILED", "WAITING_FOR_APPROVAL"],
  FAILED: ["WAITING_FOR_APPROVAL", "FAILED"],
  APPROVED: ["BUILT", "FAILED"],
  BUILT: [],
  REJECTED: [],
};

export interface ComposeRun {
  runId: string;
  mode: "compose";
  request: string;
  state: ComposeState;
  history: Array<{ at: string; state: ComposeState; note?: string }>;
  /** How the model was asked — absent when the run started from a config. */
  draft?: Omit<CompositionDraft, "composition">;
  composition?: Composition;
  /** Hand edits to the config since the draft, in order. */
  edits: Array<{ at: string; ok: boolean }>;
  buildDir?: string;
  approval?: { at: string; by: string };
  error?: string;
  parentRunId?: string;
}

export class ComposeStateError extends Error {}

const RUNS = new Map<string, ComposeRun>();

function transition(run: ComposeRun, to: ComposeState, note?: string): void {
  if (!LEGAL[run.state].includes(to)) throw new ComposeStateError(`${run.state} -> ${to} is not a legal transition`);
  run.state = to;
  run.history.push({ at: new Date().toISOString(), state: to, note });
}

export function getComposeRun(id: string): ComposeRun | undefined {
  return RUNS.get(id);
}

export function listComposeRuns(): ComposeRun[] {
  return [...RUNS.values()].sort((a, b) => b.history[0].at.localeCompare(a.history[0].at));
}

/** Where a composition lands once it is in: needs answers, ready for a person, or broken. */
function settle(run: ComposeRun, c: Composition, force: boolean, note: string): void {
  run.composition = c;
  if (!c.app) {
    // With no config there is nothing on the page to fix — the only way on is a new draft.
    run.error = c.config
      ? `${c.problems.length} problem${c.problems.length === 1 ? "" : "s"} — fix the config below, or draft again`
      : "the model's answer could not be read as a configuration — draft it again";
    transition(run, "FAILED", note);
    return;
  }
  run.error = undefined;
  const structural = c.app.openQuestions.filter((q) => q.blocks === "structure");
  if (structural.length && !force && run.state === "DRAFTING") {
    transition(run, "CLARIFICATION_REQUIRED", `${structural.length} question(s) change what gets built`);
    return;
  }
  transition(run, "WAITING_FOR_APPROVAL", note);
}

export interface ComposeOptions {
  cacheDir: string;
  force?: boolean;
  /** Called once the run exists, before the model is asked — the page follows it by polling. */
  onStart?: (run: ComposeRun) => void;
  /** For tests: the model. */
  complete?: DraftDeps["complete"];
}

function newRun(request: string, parentRunId?: string): ComposeRun {
  const run: ComposeRun = {
    runId: randomUUID().slice(0, 8),
    mode: "compose",
    request,
    state: "REQUEST_RECEIVED",
    history: [{ at: new Date().toISOString(), state: "REQUEST_RECEIVED" }],
    edits: [],
    ...(parentRunId ? { parentRunId } : {}),
  };
  RUNS.set(run.runId, run);
  return run;
}

export async function startCompose(request: string, opts: ComposeOptions, parentRunId?: string): Promise<ComposeRun> {
  const run = newRun(request, parentRunId);
  transition(run, "DRAFTING");
  opts.onStart?.(run);
  try {
    const d = await draftComposition(request, { cacheDir: opts.cacheDir, complete: opts.complete });
    const { composition, ...meta } = d;
    run.draft = meta;
    settle(run, composition, Boolean(opts.force), d.cached ? "from cache — no tokens" : `${d.calls.length} model call(s)`);
  } catch (e) {
    run.error = e instanceof Error ? e.message : String(e);
    transition(run, "FAILED", "the model could not be asked");
  }
  return run;
}

/** Answers to the structural questions, folded into the request and drafted again. */
export async function clarifyCompose(runId: string, answers: string, opts: ComposeOptions): Promise<ComposeRun> {
  const prev = RUNS.get(runId);
  if (!prev) throw new ComposeStateError(`no run ${runId}`);
  if (prev.state !== "CLARIFICATION_REQUIRED") throw new ComposeStateError(`run is ${prev.state}; only a run waiting on answers takes them`);
  if (opts.force || !answers.trim()) {
    // Proceed with the questions carried as assumptions — no new draft needed.
    transition(prev, "WAITING_FOR_APPROVAL", "questions carried as assumptions");
    opts.onStart?.(prev);
    return prev;
  }
  transition(prev, "REJECTED", "superseded by the answered request");
  return startCompose(`${prev.request}\n\nAnswers to the open questions:\n${answers.trim()}`, opts, prev.runId);
}

/** A run from a config a person wrote or picked — no model, composed at once. */
export function composeFromConfig(config: unknown, label: string): ComposeRun {
  const run = newRun(label);
  settle(run, compose(config), true, "from a config — no model");
  return run;
}

/** An edit to the config of a run not yet built: composed again, in code, at once. */
export function editCompose(runId: string, config: unknown): ComposeRun {
  const run = RUNS.get(runId);
  if (!run) throw new ComposeStateError(`no run ${runId}`);
  if (!["WAITING_FOR_APPROVAL", "FAILED"].includes(run.state)) throw new ComposeStateError(`run is ${run.state}; only an unbuilt draft can be edited`);
  const c = compose(config);
  run.edits.push({ at: new Date().toISOString(), ok: !!c.app });
  settle(run, c, true, c.app ? "edited and composed again" : "edited — does not compose");
  return run;
}

export function decideCompose(runId: string, approve: boolean, by: string): ComposeRun {
  const run = RUNS.get(runId);
  if (!run) throw new ComposeStateError(`no run ${runId}`);
  if (run.state !== "WAITING_FOR_APPROVAL") throw new ComposeStateError(`run is ${run.state}; only a composed draft can be decided`);
  run.approval = { at: new Date().toISOString(), by };
  transition(run, approve ? "APPROVED" : "REJECTED", `${approve ? "approved" : "rejected"} by ${by}`);
  return run;
}

export function buildCompose(runId: string, repoRoot: string): ComposeRun {
  const run = RUNS.get(runId);
  if (!run) throw new ComposeStateError(`no run ${runId}`);
  if (run.state !== "APPROVED") throw new ComposeStateError(`run is ${run.state}; only an approved draft is built`);
  try {
    run.buildDir = writeBuild(run.composition!, repoRoot, run.request);
  } catch (e) {
    run.error = `writing the build: ${e instanceof Error ? e.message : String(e)}`;
    transition(run, "FAILED", run.error);
    return run;
  }
  transition(run, "BUILT", run.buildDir);
  return run;
}

/**
 * What the page draws: the run, and its composition put in the page's terms — modules with
 * their tables, every stage, every rule that waits for a person, and what the agent may
 * do. Worked out here so the page renders and never has to understand a composition.
 */
export function composeView(run: ComposeRun) {
  const c = run.composition;
  return {
    runId: run.runId,
    mode: run.mode,
    request: run.request,
    state: run.state,
    history: run.history,
    draft: run.draft ?? null,
    problems: c?.problems ?? [],
    notes: c?.notes ?? [],
    config: c?.config ?? null,
    summary: c?.app ? summarise(c.app) : null,
    edits: run.edits,
    buildDir: run.buildDir ?? null,
    approval: run.approval ?? null,
    error: run.error ?? null,
    parentRunId: run.parentRunId ?? null,
  };
}

export function summarise(app: ComposedApp) {
  const label = (n: string) => app.entities.find((e) => e.name === n)?.label ?? n;
  const policy = agentPolicy(toAppManifest(app));
  return {
    id: app.id,
    label: app.label,
    business: app.business,
    board: label(app.primary),
    counts: { modules: app.modules.length, tables: app.entities.length, actions: app.actions.length, held: app.actions.filter((a) => a.policy.mode !== "auto").length, custom: app.actions.filter((a) => a.custom).length },
    modules: app.modules.map((m) => ({ id: m.id, label: m.label, category: m.category, summary: m.summary, tables: m.entities.map(label), settings: m.settings })),
    stages: app.entities.filter((e) => e.lifecycle).map((e) => ({
      entity: e.name,
      label: e.label,
      board: e.name === app.primary,
      states: e.lifecycle!.order.map((s) => ({ id: s, label: e.lifecycle!.states[s].label, requirements: e.lifecycle!.states[s].requirements ?? [], terminal: e.lifecycle!.states[s].next.length === 0 })),
    })),
    held: app.actions.filter((a) => a.policy.mode !== "auto").map((a) => ({ action: a.name, label: a.label, on: label(a.entity), rule: policyLine(app, a.policy), approver: a.policy.mode === "auto" ? "" : a.policy.approver, custom: !!a.custom })),
    custom: app.actions.filter((a) => a.custom).map((a) => ({ action: a.name, label: a.label, summary: a.summary, when: a.when ?? [], to: a.to ?? null })),
    openQuestions: app.openQuestions,
    agent: { mcpId: policy.mcpId, agentId: policy.agentId, allowed: policy.allow.length, blocked: policy.block },
  };
}

/** The catalogue as the page's sidebar shows it. */
export function catalogueView() {
  return CATALOG.map((m) => ({
    id: m.id,
    label: m.label,
    category: m.category,
    summary: m.summary,
    usedBy: m.usedBy,
    tables: m.entities.map((e) => e.label),
    actions: m.actions.length,
    extensible: !!m.extensible,
  }));
}

/** The example configs shipped with the catalogue, by name. */
export function examples(repoRoot: string): Array<{ name: string; label: string; business: string }> {
  const dir = join(repoRoot, "src", "modules", "examples");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { label: string; business: { name: string } };
      return { name: f.replace(/\.json$/, ""), label: c.label, business: c.business.name };
    });
}

export function exampleConfig(repoRoot: string, name: string): unknown {
  if (!/^[a-z0-9-]+$/.test(name)) throw new ComposeStateError("not an example name");
  return JSON.parse(readFileSync(join(repoRoot, "src", "modules", "examples", `${name}.json`), "utf-8"));
}

/** For tests. */
export function _resetComposeRuns(): void {
  RUNS.clear();
}
