/**
 * Compose a business from the module catalogue.
 *
 *   npm run compose -- "a dental clinic in Chennai that books by phone"   # the model drafts the config
 *   npm run compose -- --example dental-clinic                           # one of src/modules/examples
 *   npm run compose -- --config builds/dental_clinic-1a2b3c/config.json  # a config a person edited
 *   npm run compose -- --catalogue                                       # list the modules
 *   npm run compose -- --check                                           # is a model reachable, with our key?
 *
 * Add --dry to see the result without writing a build. A drafted config is cached under
 * builds/.cache, so asking again costs nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/builder/env.js";
import { CATALOG } from "../src/modules/catalog/index.js";
import { compose, type Composition } from "../src/modules/compose.js";
import { draftComposition } from "../src/modules/draft.js";
import { writeBuild, policyLine } from "../src/modules/build.js";
import { routerStatus } from "../src/builder/router.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes("--dry");

if (args.includes("--catalogue")) {
  for (const m of CATALOG) console.log(`${m.id.padEnd(13)} ${m.label.padEnd(24)} ${m.summary}`);
  process.exit(0);
}

/**
 * Whether a model can be asked at all, said plainly. Without KILO_API_KEY the router falls
 * back to a local OmniRoute, so a missing key otherwise surfaces as "every model on the
 * omniroute ladder failed" — true, and no help to someone who meant to use Kilo.
 */
async function modelReady(verbose: boolean): Promise<boolean> {
  const s = await routerStatus();
  const where = `${s.gatewayName} (${s.gateway})`;
  if (!s.gatewayUp || !s.gatewayAuthorised) {
    console.error(`\nNo model to draft with — ${where}: ${s.gatewayError ?? (s.gatewayUp ? "the key was refused" : "not reachable")}.`);
    if (s.gatewayName !== "kilo") console.error("Set KILO_API_KEY in .env (see .env.example) to draft on Kilo's free models, or run OmniRoute locally.");
    else if (s.gatewayUp) console.error("Kilo answered but refused the key — check KILO_API_KEY in .env.");
    console.error("Composing from a config needs no model: npm run compose -- --example dental-clinic\n");
    return false;
  }
  if (verbose) {
    console.log(`Model gateway: ${where} — up, key accepted.`);
    console.log(`Ladder: ${s.ladder.join(" → ")}`);
    if (s.notFree.length) console.log(`Warning: not listed as free right now: ${s.notFree.join(", ")}`);
    if (s.paidFallback) console.log(`Paid fallback enabled: ${s.directModel}`);
  }
  return true;
}

if (args.includes("--check")) process.exit((await modelReady(true)) ? 0 : 1);

let composition: Composition;
let request: string | undefined;
const example = flag("--example");
const config = flag("--config");
if (example || config) {
  const file = example ? join(root, "src", "modules", "examples", `${example}.json`) : resolve(config!);
  if (!existsSync(file)) {
    console.error(`no such config: ${file}`);
    process.exit(1);
  }
  composition = compose(JSON.parse(readFileSync(file, "utf-8")));
} else {
  request = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!request) {
    console.error('usage: npm run compose -- "<the business, in a sentence>" | --example <name> | --config <file> [--dry]');
    process.exit(1);
  }
  if (!(await modelReady(false))) process.exit(1);
  console.log(`Drafting "${request}"…`);
  let draft: Awaited<ReturnType<typeof draftComposition>>;
  try {
    draft = await draftComposition(request, { cacheDir: join(root, "builds", ".cache") });
  } catch (e) {
    console.error(`\nThe model call failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  console.log(draft.cached ? "  (from cache — no tokens)" : `  ${draft.calls.length} model call(s), ${draft.usage.input} in / ${draft.usage.output} out`);
  if (draft.repaired?.length) console.log(`  repaired: ${draft.repaired.length} problem(s) in the first answer`);
  if (draft.raw) console.log(`\nThe model's answer was not usable:\n${draft.raw}\n`);
  composition = draft.composition;
}

const app = composition.app;
if (!app) {
  console.error(`\nCannot build — ${composition.problems.length} problem(s):`);
  for (const p of composition.problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`\n${app.business.name} — ${app.label}`);
console.log(`${app.modules.length} modules · ${app.entities.length} tables · ${app.actions.length} actions · board: ${app.entities.find((e) => e.name === app.primary)?.label}`);
for (const m of app.modules) console.log(`  ${m.label.padEnd(26)} ${m.entities.map((n) => app.entities.find((e) => e.name === n)?.label).join(", ")}`);
const held = app.actions.filter((a) => a.policy.mode !== "auto");
console.log(`\n${held.length} action(s) wait for a person:`);
for (const a of held) console.log(`  ${a.label.padEnd(26)} ${policyLine(app, a.policy)}`);
if (composition.notes.length) {
  console.log("\nComposing changed:");
  for (const n of composition.notes) console.log(`  ~ ${n}`);
}
if (app.openQuestions.length) {
  console.log("\nOpen questions:");
  for (const q of app.openQuestions) console.log(`  ? ${q.question}`);
}

if (dry) process.exit(0);
const dir = writeBuild(composition, root, request);
console.log(`\nWritten to ${dir}/\nRun it:  npm run app -- ${dir.split("/").pop()}\n`);
