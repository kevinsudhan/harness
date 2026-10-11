/**
 * The builder page's composition runs — composeRun.ts, with a fake model and a temp repo.
 *
 * Pins the path a person takes on the page: a draft lands waiting for approval, or stops
 * for questions that change what gets built, or fails with its problems listed; a failed or
 * waiting draft can be fixed by editing its config, composed again in code with no model;
 * approval needs a name; building writes a folder; a built run is no longer editable.
 *
 * Run: tsx src/builder/composeRun.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startCompose, clarifyCompose, composeFromConfig, editCompose, decideCompose, buildCompose, composeView, examples, exampleConfig, ComposeStateError, _resetComposeRuns,
} from "./composeRun.js";
import type { CompletionRequest, CompletionResult } from "./router.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function throws(label: string, fn: () => unknown, match: RegExp) {
  try { fn(); ok(label, false, "did not throw"); } catch (e) { ok(label, e instanceof ComposeStateError && match.test(e.message), e instanceof Error ? e.message : e); }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "compose-run-"));
const gym = exampleConfig(repo, "mma-gym") as Record<string, unknown> & { modules: Array<{ id: string }>; openQuestions: Array<{ question: string; blocks: string }> };
const answer = (text: string) => async (_req: CompletionRequest): Promise<CompletionResult> =>
  ({ text, usedModel: "fake", resolvedModel: "fake", backend: "kilo", skipped: [], usage: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0 } });

try {
  console.log("\n1. A draft lands waiting for a person");
  {
    _resetComposeRuns();
    const seen: string[] = [];
    const run = await startCompose("an MMA gym in Bengaluru", { cacheDir: join(tmp, "cache"), complete: answer(JSON.stringify(gym)), onStart: (r) => seen.push(r.state) });
    ok("the page hears about the run while it drafts", seen[0] === "DRAFTING");
    ok("it waits for approval", run.state === "WAITING_FOR_APPROVAL");
    const v = composeView(run);
    ok("the view puts it in the page's terms: modules, the board, what waits", v.summary?.counts.modules === 10 && v.summary.board === "Memberships" && v.summary.held.some((h) => h.action === "cancel_membership"));
    ok("…and what its agent may do", (v.summary?.agent.allowed ?? 0) > 0 && v.summary!.agent.blocked.some((b) => b.tool === "erase_contact"));
    ok("the config is there to read and edit", (v.config as { id?: string } | null)?.id === "mma_gym");
    ok("how it was drafted is kept, tokens and all", v.draft?.usage.input === 900 && v.draft.calls.length === 1);
  }

  console.log("\n2. Questions that change what gets built stop the run — unless told not to");
  {
    const q = structuredClone(gym);
    q.openQuestions = [{ question: "Do you also sell supplements?", blocks: "structure" }];
    const run = await startCompose("an MMA gym that might sell supplements", { cacheDir: join(tmp, "cache2"), complete: answer(JSON.stringify(q)) });
    ok("a structural question stops it", run.state === "CLARIFICATION_REQUIRED");
    const on = await clarifyCompose(run.runId, "", { cacheDir: join(tmp, "cache2"), force: true, complete: answer(JSON.stringify(q)) });
    ok("proceeding with assumptions needs no new draft", on.runId === run.runId && on.state === "WAITING_FOR_APPROVAL");
    const forced = await startCompose("an MMA gym that might sell supplements, again", { cacheDir: join(tmp, "cache3"), force: true, complete: answer(JSON.stringify(q)) });
    ok("with force, it goes straight to approval, the question kept", forced.state === "WAITING_FOR_APPROVAL" && composeView(forced).summary!.openQuestions.length === 1);
  }

  console.log("\n3. A draft that does not compose is fixed by editing it — no model");
  {
    const broken = structuredClone(gym);
    broken.modules.push({ id: "loyalty_points" });
    let calls = 0;
    const run = await startCompose("a gym with loyalty points", { cacheDir: join(tmp, "cache4"), complete: async (req) => { calls++; return answer(JSON.stringify(broken))(req); } });
    ok("both the draft and its one repair fail: FAILED, problems listed", run.state === "FAILED" && calls === 2 && composeView(run).problems.some((p) => /loyalty_points/.test(p)));
    ok("…with the config kept, to be fixed by hand", composeView(run).config !== null);
    const fixed = editCompose(run.runId, gym);
    ok("an edit that composes brings it back to approval", fixed.state === "WAITING_FOR_APPROVAL" && fixed.edits.length === 1 && fixed.edits[0].ok);
    const worse = editCompose(run.runId, { ...gym, primary: "contact" });
    ok("an edit that breaks it shows why, and does not lose the run", worse.state === "FAILED" && composeView(worse).problems.some((p) => /no stages/.test(p)));
    const back = editCompose(run.runId, gym);
    ok("…and can be fixed again", back.state === "WAITING_FOR_APPROVAL" && back.edits.length === 3);
  }

  console.log("\n4. Approval, then a build on disk");
  {
    const run = composeFromConfig(exampleConfig(repo, "salon"), "Example: Mirror Salon");
    ok("an example composes at once, no model", run.state === "WAITING_FOR_APPROVAL" && !run.draft);
    throws("building before approval is refused", () => buildCompose(run.runId, tmp), /only an approved draft is built/);
    decideCompose(run.runId, true, "Asha");
    const built = buildCompose(run.runId, tmp);
    ok("built: the folder is written", built.state === "BUILT" && !!built.buildDir && existsSync(join(tmp, built.buildDir!, "app.json")));
    ok("…with its config, schema, notes and the agent's ArmorIQ policy", ["config.json", "schema.sql", "BUILD.md", "armoriq/policy.yaml", "armoriq/armoriq.yaml"].every((f) => existsSync(join(tmp, built.buildDir!, f))));
    ok("the config on disk is the one that was approved", JSON.parse(readFileSync(join(tmp, built.buildDir!, "config.json"), "utf-8")).id === "salon");
    throws("a built run is no longer editable", () => editCompose(run.runId, gym), /only an unbuilt draft can be edited/);
    throws("nor decided again", () => decideCompose(run.runId, true, "Ravi"), /only a composed draft can be decided/);
  }

  console.log("\n5. The examples the page offers");
  {
    const list = examples(repo);
    ok("every shipped example is listed with its business", list.length >= 4 && list.every((x) => x.business && x.label));
    throws("an example name cannot become a path", () => exampleConfig(repo, "../../package"), /not an example name/);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} compose-run check(s) FAILED` : "\nAll compose-run checks passed.");
if (failures) process.exit(1);
