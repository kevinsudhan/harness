/**
 * The module catalogue, the formula language and composition.
 *
 * What these pin down: every module in the catalogue composes with every other one; the
 * example businesses — four very different shapes — compose from the same catalogue with
 * no problems; and the mistakes a model makes when configuring one are caught, by name,
 * before an app exists. The formula tests pin the language a module's logic is written in.
 *
 * Run: tsx src/modules/modules.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "./catalog/index.js";
import { compose, everything, validate, tagFor, type ComposedApp } from "./compose.js";
import { parse, run, references, FormulaError, type Scope } from "./formula.js";
import { draftComposition } from "./draft.js";
import { parseLenient } from "./jsonRepair.js";
import type { CompletionResult } from "../builder/router.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
const has = (list: string[], re: RegExp) => list.some((x) => re.test(x));

const here = dirname(fileURLToPath(import.meta.url));
const example = (name: string) => JSON.parse(readFileSync(join(here, "examples", `${name}.json`), "utf-8"));

// --------------------------------------------------------------------------- formulas

console.log("\n1. Formulas");
{
  const row: Record<string, unknown> = { total: 1180, amount_paid: 400, due_date: "2026-10-01", name: "Smile", rate: null };
  const lines = [{ amount: 1000, state: "x" }, { amount: 180, state: "y" }];
  const scope: Scope = {
    get: (p) => (p[0] === "param" ? ({ amount: 50 } as Record<string, unknown>)[p[1]] : p[0] === "setting" ? 15 : row[p[0]]),
    children: () => lines.map((l) => ({ ...scope, get: (p: string[]) => (l as Record<string, unknown>)[p[0]] })),
    today: () => "2026-10-10",
    now: () => "2026-10-10T09:00:00.000Z",
    actor: () => "Asha",
    id: () => "DEN-INV-0001",
    created: () => null,
  };
  ok("arithmetic and precedence", run("total - amount_paid * 2", scope) === 380);
  ok("null reads as zero in arithmetic", run("rate * 3 + 1", scope) === 1);
  ok("division by zero is empty, not Infinity", run("total / 0", scope) === null);
  ok("comparison of dates as text", run("due_date < today()", scope) === true);
  ok("and / or / not", run("not (total > 100 and amount_paid > 1000) or false", scope) === true);
  ok("params and settings", run("param.amount + setting.payment_terms_days", scope) === 65);
  ok("text joins with +", run("name + ' · ' + 4", scope) === "Smile · 4");
  ok("add_days keeps a date a date", run("add_days(today(), setting.payment_terms_days)", scope) === "2026-10-25");
  ok("add_minutes on a moment", run("add_minutes(now(), 90)", scope) === "2026-10-10T10:30:00.000Z");
  ok("days_between", run("days_between(due_date, today())", scope) === 9);
  ok("coalesce skips blanks", run("coalesce(rate, '', 7)", scope) === 7);
  ok("if", run("if(total > 1000, 'big', 'small')", scope) === "big");
  ok("sum over children", run("sum(invoice_line.amount)", scope) === 1180);
  ok("sum with a condition read on each child", run("sum(invoice_line.amount, state = 'y')", scope) === 180);
  ok("count", run("count(invoice_line)", scope) === 2);
  ok("round", run("round(10 / 3, 2)", scope) === 3.33);

  const threw = (src: string) => { try { parse(src); return false; } catch (e) { return e instanceof FormulaError; } };
  ok("an unknown function is refused at parse time", threw("eval(1)"));
  ok("a wrong argument count is refused", threw("add_days(today())"));
  ok("an unclosed bracket is refused", threw("(total + 1"));
  ok("sum needs an entity, not an expression", threw("sum(1 + 2)"));
  ok("trailing junk is refused", threw("total total"));

  const refs = references(parse("sum(payment.amount, state = 'received') + contact_id.full_name"));
  ok("references name the aggregate and its inner reads", refs.some((r) => r.kind === "aggregate" && r.entity === "payment" && r.field === "amount" && r.inner.length === 1));
  ok("references name a followed link", refs.some((r) => r.kind === "path" && r.path.join(".") === "contact_id.full_name"));
}

// ------------------------------------------------------------------- almost-JSON answers

console.log("\n1b. A model's almost-JSON is repaired in code");
{
  const lf = example("law-firm");
  const clean = JSON.stringify(lf);
  // The live failure: a module closed with one brace too many — `}}}}},` in the module list.
  const extra = clean.replace(`},{"id":"accounts"`, `}},{"id":"accounts"`);
  ok("the reproduction really is broken", (() => { try { JSON.parse(extra); return false; } catch { return true; } })());
  const r1 = parseLenient(extra);
  ok("one brace too many is dropped, and the config is the original", JSON.stringify(r1.value) === clean && r1.fixes.length === 1 && /removed a '}' with nothing to close/.test(r1.fixes[0]));
  ok("…which then composes", compose(r1.value).app !== null);

  const forgot = `{"modules": [{"id": "contacts"], "id": "x"}`;
  const r2 = parseLenient(forgot);
  ok("a forgotten closer is added where it was forgotten, not at the end", JSON.stringify(r2.value) === `{"modules":[{"id":"contacts"}],"id":"x"}`, r2);

  const messy = "Here is the configuration:\n```json\n{\n  // the business\n  \"id\": \"a\",\n  \"list\": [1, 2, 3,],\n  /* done */ \"b\": {\"c\": true,},\n}\n```\nLet me know if you need changes.";
  const r3 = parseLenient(messy);
  ok("comments, trailing commas, a fence and prose around it", JSON.stringify(r3.value) === `{"id":"a","list":[1,2,3],"b":{"c":true}}`, r3.value);

  const cut = `{"id": "a", "modules": [{"id": "contacts"}, {"id": "invoicing"`;
  ok("an answer cut off at the end is closed", JSON.stringify(parseLenient(cut).value) === `{"id":"a","modules":[{"id":"contacts"},{"id":"invoicing"}]}`);
  ok("brackets inside strings are left alone", JSON.stringify(parseLenient(`{"note": "a } and a ] in text", "x": [1}`).value) === `{"note":"a } and a ] in text","x":[1]}`);
  let threw = false;
  try { parseLenient("I think a bakery needs a CRM."); } catch { threw = true; }
  ok("prose with no JSON in it is still refused", threw);
}

// -------------------------------------------------------------------------- catalogue

console.log("\n2. The catalogue holds together");
{
  const ids = CATALOG.map((m) => m.id);
  ok("module ids are unique", new Set(ids).size === ids.length);
  const entities = CATALOG.flatMap((m) => m.entities.map((e) => e.name));
  ok("entity names are unique across the catalogue", new Set(entities).size === entities.length, entities.filter((e, i) => entities.indexOf(e) !== i));
  const actions = CATALOG.flatMap((m) => m.actions.map((a) => a.name));
  ok("action names are unique across the catalogue — each is one tool name", new Set(actions).size === actions.length, actions.filter((a, i) => actions.indexOf(a) !== i));
  ok("reference tags read as the entity: INV, IL, POL", tagFor("invoice") === "INV" && tagFor("invoice_line") === "IL" && tagFor("purchase_order_line") === "POL");
  ok("at least 25 modules across every category", CATALOG.length >= 25 && new Set(CATALOG.map((m) => m.category)).size === 7);

  for (const m of CATALOG) {
    for (const e of m.entities) {
      for (const f of e.fields) {
        if (f.type === "ref" && f.required) {
          const owner = CATALOG.find((x) => x.entities.some((y) => y.name === f.ref));
          ok(`${e.name}.${f.name}: a required link points into ${m.id} or a module it requires`, owner?.id === m.id || m.requires.includes(owner?.id ?? ""), owner?.id);
        }
      }
    }
    for (const a of m.actions) {
      const owner = CATALOG.find((x) => x.entities.some((y) => y.name === a.entity));
      if (owner?.id !== m.id) ok(`${a.name}: acts on ${a.entity} from ${owner?.id}, which ${m.id} requires`, m.requires.includes(owner?.id ?? ""));
    }
  }

  const all = compose(everything());
  ok("every module composes with every other, with no problems", all.problems.length === 0, all.problems.slice(0, 5));
  ok("…and nothing needed adjusting", all.notes.length === 0, all.notes.slice(0, 5));
  ok("the full catalogue offers every action", all.app?.actions.length === actions.length, [all.app?.actions.length, actions.length]);
}

// ----------------------------------------------------------------- example businesses

console.log("\n3. Four different businesses from one catalogue");
{
  const files = readdirSync(join(here, "examples")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  ok("there are examples to check", files.length >= 4, files);
  const built = new Map<string, ComposedApp>();
  for (const f of files) {
    const r = compose(example(f));
    ok(`${f} composes with no problems`, r.problems.length === 0, r.problems);
    if (r.app) built.set(f, r.app);
  }

  const dental = built.get("dental-clinic")!;
  const patient = dental.entities.find((e) => e.name === "contact")!;
  ok("dental: contacts are relabelled Patients, the table is still contact", patient.label === "Patients" && patient.name === "contact");
  ok("dental: a field the clinic added is there", patient.fields.some((f) => f.name === "allergies" && f.added && f.pii));
  ok("dental: an optional field the clinic dropped is gone", !patient.fields.some((f) => f.name === "account_id"));
  const course = dental.entities.find((e) => e.name === "work_item")!;
  ok("dental: the pipeline runs the clinic's own stages", course.lifecycle?.initial === "consultation" && course.lifecycle.order.includes("in_treatment"));
  const prescribe = dental.actions.find((a) => a.name === "prescribe");
  ok("dental: prescribing is the clinic's own action, held for compliance", prescribe?.custom === true && prescribe.policy.mode === "approve" && prescribe.policy.approver === "compliance");
  const issue = dental.actions.find((a) => a.name === "issue_invoice")!;
  ok("dental: the clinic's ₹25,000 brake replaced the default", issue.policy.mode === "threshold" && issue.policy.limit === 25_000);
  ok("dental: a custom action can book into the appointments module", dental.actions.find((a) => a.name === "book_next_visit")?.creates?.entity === "appointment");
  ok("dental: the estimate keeps the module's discount brake, at 15%", dental.actions.find((a) => a.name === "send_quote")?.policy.mode === "threshold");

  const gym = built.get("mma-gym")!;
  ok("gym: no pipeline, so the board is memberships", gym.primary === "membership" && !gym.entities.some((e) => e.name === "work_item"));
  ok("gym: links to modules it does not have are gone", !gym.entities.find((e) => e.name === "appointment")!.fields.some((f) => f.name === "work_item_id"));
  ok("gym: converting a lead into pipeline work is not offered", !gym.actions.some((a) => a.name === "convert_enquiry"));
  ok("gym: cancelling a membership asks the head coach", gym.actions.find((a) => a.name === "cancel_membership")?.policy.mode === "approve");
  ok("gym: state relabels reach the lifecycle", gym.entities.find((e) => e.name === "enquiry")!.lifecycle!.states.qualified.label === "Trial booked");

  const law = built.get("law-firm")!;
  ok("law firm: matters run intake → conflict check → engagement", law.entities.find((e) => e.name === "work_item")!.lifecycle!.order.slice(0, 3).join(",") === "intake,conflict_check,engagement");
  const offer = law.actions.find((a) => a.name === "send_settlement_offer")!;
  ok("law firm: a threshold with no figure gets an amount param to compare", offer.measure?.amount === "param.amount" && !!offer.params?.some((p) => p.name === "amount"));
  ok("law firm: deadlines warn three days out", law.modules.find((m) => m.id === "commitments")!.settings.warn_before_minutes === 4320);

  const salon = built.get("salon")!;
  ok("salon: the board is bookings, a module lifecycle, not a pipeline", salon.primary === "appointment");
  ok("salon: replying to reviews is not held here", salon.actions.find((a) => a.name === "respond_to_feedback")?.policy.mode === "auto");

  const shared = ["contact", "invoice", "payment"].every((e) => [...built.values()].every((app) => app.entities.some((x) => x.name === e)));
  ok("every example shares the same contact, invoice and payment tables", shared);
}

// --------------------------------------------------------------- what composition fixes

console.log("\n4. Slips with one right answer are fixed, with a note");
{
  const base = () => structuredClone(example("salon"));
  const cfg = base();
  cfg.modules = cfg.modules.filter((m: { id: string }) => m.id !== "contacts" && m.id !== "invoicing");
  const r = compose(cfg);
  ok("a module another needs is added", r.problems.length === 0 && has(r.notes, /added the contacts module/) && has(r.notes, /added the invoicing module/), r.problems);

  const c2 = base();
  c2.modules[0].entities.contact.drop.push("full_name", "do_not_contact");
  const r2 = compose(c2);
  ok("a drop of a field the logic reads is ignored", has(r2.notes, /kept "full_name"/) && has(r2.notes, /kept "do_not_contact"/) && r2.app!.entities[0].fields.some((f) => f.name === "do_not_contact"));

  const c3 = base();
  c3.modules.find((m: { id: string }) => m.id === "appointments").entities.appointment.drop.push("resource_id");
  const r3 = compose(c3);
  ok("a field another module's rule reads cannot be dropped (no-overlap reads resource_id)", has(r3.notes, /kept "resource_id"/));

  // Both measured on a live law-firm draft: the same question twice, and nine notes about
  // relabelling links to modules the firm does not have.
  const c5 = base();
  c5.openQuestions = [{ question: "Which brands do you stock?", blocks: "behaviour" }, { question: "which brands do you stock? ", blocks: "behaviour" }];
  c5.modules[0].entities.contact.relabel = { account_id: "Company" };
  const r5 = compose(c5);
  ok("a question asked twice is asked once", r5.app?.openQuestions.length === 1);
  ok("relabelling a link to a module the build lacks is not reported as a slip", !has(r5.notes, /account_id/));

  // The second live law-firm failure: brackets miscounted so the pipeline's lifecycle landed
  // inside "entities", and "primary" inside the last module.
  const lf = example("law-firm");
  const pipe = lf.modules.find((m: { id: string }) => m.id === "pipeline");
  pipe.entities.lifecycle = pipe.lifecycle;
  delete pipe.lifecycle;
  pipe.entities.work_item.customActions = pipe.customActions;
  delete pipe.customActions;
  lf.modules[lf.modules.length - 1].primary = lf.primary;
  delete lf.primary;
  const r6 = compose(lf);
  ok("a lifecycle written inside entities is moved up to its module, and it composes", r6.app !== null && r6.app.entities.find((e) => e.name === "work_item")!.lifecycle!.initial === "intake", r6.problems.slice(0, 3));
  ok("…so are custom actions written inside the entity", r6.app?.actions.some((a) => a.name === "file_with_court") === true);
  ok("…and a primary written inside a module is moved up to the top", r6.app?.primary === "work_item");
  ok("…each move is noted", has(r6.notes, /"lifecycle" was written inside entities — moved up/) && has(r6.notes, /"primary" was written inside the staff module — moved up/));

  const c4 = base();
  delete c4.primary;
  const r4 = compose(c4);
  ok("no primary given: the first module with stages is the board", r4.app?.primary === "appointment" && has(r4.notes, /board shows appointment/));
}

// -------------------------------------------------------------- what composition refuses

console.log("\n5. Mistakes that need judgement are reported by name");
{
  const dental = () => structuredClone(example("dental-clinic"));
  const pipe = (c: ReturnType<typeof dental>) => c.modules.find((m: { id: string }) => m.id === "pipeline");

  const r1 = compose({ ...dental(), modules: [...dental().modules, { id: "crypto_wallet" }] });
  ok("an unknown module", has(r1.problems, /no module "crypto_wallet"/));

  const c2 = dental();
  pipe(c2).lifecycle.states.review.next = [];
  pipe(c2).lifecycle.states.in_treatment.next = ["discontinued"];
  const r2 = compose(c2);
  ok("a stage nothing reaches", has(r2.problems, /"review" cannot be reached/), r2.problems);

  const c3 = dental();
  pipe(c3).customActions.push({ name: "bill_patient", label: "Bill", summary: "x", effects: ["money"], policy: { mode: "auto" }, when: ["review"], to: "consultation" });
  const r3 = compose(c3);
  ok("an action moving somewhere its states do not lead", has(r3.problems, /bill_patient: moves to "consultation" but is offered in review/), r3.problems);

  const c4 = dental();
  pipe(c4).customActions.push({ name: "issue_invoice", label: "x", summary: "x", effects: ["money"], policy: { mode: "auto" } });
  ok("a custom action reusing a module's action name", has(compose(c4).problems, /"issue_invoice" is already an action of another module/));

  const c5 = dental();
  c5.modules[0].entities.contact.add.push({ name: "age", type: "integer", formula: "days_between(birthday, today()) / 365" });
  ok("a formula naming a field that does not exist", has(compose(c5).problems, /contact.age's formula: contact has no field "birthday"/));

  const c6 = dental();
  pipe(c6).customActions.push({ name: "refer_out", label: "Refer", summary: "x", effects: ["outbound"], policy: { mode: "auto" }, guard: { if: "param.specialist != null", else: "x" } });
  ok("a guard reading a param the action does not take", has(compose(c6).problems, /no param "specialist"/));

  const c7 = dental();
  pipe(c7).customActions.push({ name: "order_lab", label: "Lab", summary: "x", effects: ["record"], policy: { mode: "auto" }, creates: { entity: "task", fields: { details: "x" } } });
  ok("making a row in a module the build does not have", has(compose(c7).problems, /order_lab: makes a task, which is not in this build/));

  const c8 = dental();
  pipe(c8).customActions.push({ name: "book_visit", label: "Book", summary: "x", effects: ["record"], policy: { mode: "auto" }, creates: { entity: "appointment", fields: { contact_id: "=contact_id" } } });
  ok("making a row without its required fields", has(compose(c8).problems, /book_visit: makes a appointment without its required starts_at, duration_minutes/));

  const c9 = dental();
  c9.modules.find((m: { id: string }) => m.id === "appointments").lifecycle = { order: ["a", "b"], initial: "a", states: { a: { label: "A", next: ["b"] }, b: { label: "B", next: [] } } };
  ok("a lifecycle on a module whose stages are not the business's to write", has(compose(c9).problems, /only the pipeline takes its own lifecycle/));

  const c10 = dental();
  c10.modules.find((m: { id: string }) => m.id === "invoicing").actions.mark_paid = { label: "x" };
  ok("configuring an action a module does not have", has(compose(c10).problems, /invoicing has no action "mark_paid"/));

  const c11 = dental();
  c11.modules.find((m: { id: string }) => m.id === "invoicing").settings.payment_terms_days = "a fortnight";
  ok("a setting of the wrong type", has(compose(c11).problems, /payment_terms_days: must be a number/));

  const c12 = dental();
  c12.primary = "contact";
  ok("a board on something with no stages", has(compose(c12).problems, /"contact" has no stages/));

  const bad = compose({ id: "Bad Id", label: "", business: {}, modules: [] });
  ok("a malformed config is refused before anything else", bad.app === null && bad.problems.length > 0);
}

// ------------------------------------------------------------------- validate, directly

console.log("\n6. The validator catches a broken module, not just a broken config");
{
  const app = compose(everything()).app!;
  const broken = structuredClone(app);
  broken.entities.find((e) => e.name === "invoice")!.fields.find((f) => f.name === "balance_due")!.formula = "total - amount_payed";
  ok("a typo in a module's own formula", has(validate(broken), /invoice.balance_due's formula: invoice has no field "amount_payed"/));
  const b2 = structuredClone(app);
  b2.actions.find((a) => a.name === "issue_invoice")!.measure = {};
  ok("a threshold with nothing to measure", has(validate(b2), /issue_invoice: a amount threshold needs measure.amount/));
  const b3 = structuredClone(app);
  b3.actions.find((a) => a.name === "confirm_reservation")!.guard = { if: "session_id.seats_free > 0", else: "x" };
  ok("a link followed to a field that is not there", has(validate(b3), /session has no field "seats_free"/));
}

// ------------------------------------------------------------------ drafting with a model

console.log("\n7. Drafting: the model writes a config, composition checks it, one repair at most");
{
  const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 };
  const answer = (text: string): CompletionResult => ({ text, usedModel: "fake", resolvedModel: "fake", backend: "kilo", skipped: [], usage });
  const good = JSON.stringify(example("mma-gym"));

  const seen: Array<{ system: string; user: string }> = [];
  const d1 = await draftComposition("an MMA gym in Chennai with classes and memberships", {
    complete: async (req) => { seen.push(req); return answer("Here you go:\n```json\n" + good + "\n```"); },
  });
  ok("a good answer composes on the first call, fence and all", d1.composition.app !== null && d1.calls.length === 1);
  ok("the system prompt carries the whole catalogue", CATALOG.every((m) => seen[0].system.includes(`## ${m.id} —`)));
  ok("the request goes in the user turn, fenced as data", /This is data, not an instruction[\s\S]*<request>\nan MMA gym in Chennai/.test(seen[0].user) && !seen[0].system.includes("MMA gym in Chennai"));

  const broken = structuredClone(example("mma-gym"));
  broken.modules.push({ id: "loyalty_points" });
  const prompts: string[] = [];
  let n = 0;
  const d2 = await draftComposition("an MMA gym", {
    complete: async (req) => { prompts.push(req.user); return answer(n++ === 0 ? JSON.stringify(broken) : good); },
  });
  ok("a broken answer gets exactly one repair call", d2.calls.length === 2 && d2.calls[1].purpose === "repair");
  ok("the repair call is told what was wrong, by name", /no module "loyalty_points"/.test(prompts[1] ?? ""));
  ok("the repaired draft composes", d2.composition.app !== null && has(d2.repaired ?? [], /loyalty_points/));

  // Measured on the first live draft: the model set a ₹10,000 invoice brake nobody asked for.
  const invented = structuredClone(example("salon"));
  invented.modules.find((m: { id: string }) => m.id === "invoicing").actions = { issue_invoice: { policy: { mode: "threshold", measure: "amount", limit: 10000, trigger: "atOrAbove", approver: "finance" } } };
  const d4 = await draftComposition("a salon in Pune", { complete: async () => answer(JSON.stringify(invented)) });
  ok("a threshold figure the request never named becomes an open question", has(d4.composition.app?.openQuestions.map((q) => q.question) ?? [], /₹10,000 approval threshold on issue invoice was not in the request/));
  // A repair round trip sends the config back with the question already added — measured
  // live on a yoga studio, where it then appeared twice.
  const echoed = structuredClone(invented);
  echoed.openQuestions = [{ question: "The ₹10,000 approval threshold on issue invoice was not in the request — confirm the real figure.", blocks: "behaviour" }];
  const d6 = await draftComposition("a salon in Pune", { complete: async () => answer(JSON.stringify(echoed)) });
  ok("…and is asked once, even when the config comes back with it already", d6.composition.app?.openQuestions.filter((q) => /₹10,000/.test(q.question)).length === 1);
  const d5 = await draftComposition("a salon in Pune; invoices over 10,000 need the owner", { complete: async () => answer(JSON.stringify(invented)) });
  ok("…but not when the request said it (10,000 → 10000)", !has(d5.composition.app?.openQuestions.map((q) => q.question) ?? [], /threshold/));

  // The live failure end to end: the brace slip no longer costs a repair call, or the draft.
  const slipped = JSON.stringify(example("law-firm")).replace(`},{"id":"accounts"`, `}},{"id":"accounts"`);
  const d7 = await draftComposition("a law firm crm", { complete: async () => answer(slipped) });
  ok("a draft with one brace too many composes on the first call, the fix noted", d7.composition.app !== null && d7.calls.length === 1 && has(d7.composition.notes, /JSON had a slip, fixed in code/));

  const d3 = await draftComposition("a bakery", { complete: async () => answer("I think a bakery needs a CRM.") });
  ok("an answer that is not JSON is reported, with the raw text kept", d3.composition.app === null && d3.calls.length === 2 && has(d3.composition.problems, /not JSON/) && !!d3.raw);
}

console.log(failures ? `\n${failures} module check(s) FAILED` : "\nAll module checks passed.");
if (failures) process.exit(1);
