/**
 * A composed business, running: the engine on the example businesses, in a temp folder.
 *
 * What these pin down is that the modules' declarations are enough — no module has code,
 * and yet an invoice settles itself from its payments, an accepted quote becomes an invoice
 * line for line, a full class refuses a booking, a chair cannot be double-booked, a big
 * invoice waits for finance, and the person who approves it must hold the role. Each of
 * those is a declaration in a catalogue file run by the same kernel as the freight desk.
 *
 * Run: tsx src/modules/engine.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compose } from "./compose.js";
import { toAppManifest } from "./manifest.js";
import { ModuleEngine } from "./engine.js";
import { seedComposed } from "./seed.js";
import { Store } from "../app-runtime/store.js";
import { EngineError } from "../app-runtime/engine.js";
import type { AppManifest } from "../builder/appManifest.js";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function throws(label: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(label, false, "did not throw");
  } catch (e) {
    ok(label, e instanceof EngineError && match.test(e.message), e instanceof Error ? e.message : e);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
let now = new Date("2026-10-10T04:30:00.000Z");

function boot(example: string): { app: AppManifest; engine: ModuleEngine } {
  const r = compose(JSON.parse(readFileSync(join(here, "examples", `${example}.json`), "utf-8")));
  if (!r.app) throw new Error(`${example} did not compose: ${r.problems.join("; ")}`);
  const app = toAppManifest(r.app);
  const dir = mkdtempSync(join(tmpdir(), "modules-"));
  dirs.push(dir);
  return { app, engine: new ModuleEngine(app, new Store(dir), () => now) };
}

const DESK = "Asha";
const BOSS = "Ravi";

try {
  // ------------------------------------------------------------------- invoices
  console.log("\n1. An invoice settles itself from its payments");
  {
    const { engine } = boot("dental-clinic");
    const p = engine.create("contact", { full_name: "Kavya Menon", phone: "+91 98400 11111" }, DESK);
    ok("references read as the business and the table: DEN-CON-0001", p.id === "DEN-CON-0001");
    throws("a link to a row that does not exist is refused", () => engine.create("invoice", { subject: "x", contact_id: "DEN-CON-9999" }, DESK), /no patient DEN-CON-9999/);
    throws("a required field is required", () => engine.create("invoice", { contact_id: p.id }, DESK), /Invoice needs Subject/);
    throws("a computed field cannot be typed in", () => engine.create("invoice", { subject: "x", contact_id: p.id, total: 5 }, DESK), /Total is worked out by the system/);

    const inv = engine.create("invoice", { subject: "Scaling and polishing", contact_id: p.id }, DESK);
    const id = String(inv.id);
    ok("a new invoice starts as a draft", engine.stateOf("invoice", id) === "draft" && inv.stage === "draft");
    const r0 = engine.act("invoice", id, "issue_invoice", {}, DESK);
    ok("issuing an invoice with no lines is refused by its guard, in the ledger", r0.outcome === "refused" && /needs at least one line/.test(r0.entry.summary));

    engine.create("invoice_line", { invoice_id: id, description: "Scaling", quantity: 1, unit_price: 2000, tax_rate: 18 }, DESK);
    engine.create("invoice_line", { invoice_id: id, description: "Polishing", quantity: 2, unit_price: 500 }, DESK);
    let row = engine.store.get(engine.entity("invoice"), id)!;
    ok("lines total up: subtotal 3,000, tax 360, total 3,360", row.subtotal === 3000 && row.tax_amount === 360 && row.total === 3360, row);
    ok("balance due is the total until something is paid", row.balance_due === 3360);

    const r1 = engine.act("invoice", id, "issue_invoice", {}, DESK);
    row = engine.store.get(engine.entity("invoice"), id)!;
    ok("under the clinic's ₹25,000 brake, issuing just happens", r1.outcome === "performed" && engine.stateOf("invoice", id) === "issued");
    ok("issuing dates it, and terms of 0 days make it due today", row.issue_date === "2026-10-10" && row.due_date === "2026-10-10", row);

    throws("a payment needs its params", () => engine.act("invoice", id, "record_payment", { amount: 1000 }, DESK), /needs method/);
    const r2 = engine.act("invoice", id, "record_payment", { amount: 1000, method: "upi" }, DESK);
    row = engine.store.get(engine.entity("invoice"), id)!;
    ok("recording a payment makes a received payment row", r2.created?.entity === "payment" && engine.stateOf("payment", r2.created.id) === "received");
    ok("the invoice adds it up and moves to part paid on its own", row.amount_paid === 1000 && row.balance_due === 2360 && engine.stateOf("invoice", id) === "part_paid", row);
    const r3 = engine.act("invoice", id, "record_payment", { amount: 5000, method: "cash" }, DESK);
    ok("paying more than the balance is refused", r3.outcome === "refused" && /no more than the balance/.test(r3.entry.summary));
    engine.act("invoice", id, "record_payment", { amount: 2360, method: "cash" }, DESK);
    ok("the last payment settles it — paid, with nobody marking it", engine.stateOf("invoice", id) === "paid");
    ok("the automatic move is in the ledger, by the system", engine.ledger().some((l) => l.by === "system" && l.recordId === id && l.to === "paid"));
    const r4 = engine.act("invoice", id, "send_payment_reminder", {}, DESK);
    ok("a reminder on a paid invoice is illegal in its state", r4.outcome === "refused" && /not legal in paid/.test(r4.entry.summary));
    throws("an invoice is not moved by hand", () => engine.advance("invoice", id, "void", "", false, DESK), /move through their actions/);
  }

  // ------------------------------------------------------------------- approvals
  console.log("\n2. Over the brake, a person approves — the right person");
  {
    const { engine } = boot("dental-clinic");
    const p = engine.create("contact", { full_name: "Joseph Thomas" }, DESK);
    const inv = engine.create("invoice", { subject: "Implant", contact_id: p.id }, DESK);
    const id = String(inv.id);
    engine.create("invoice_line", { invoice_id: id, description: "Implant", quantity: 1, unit_price: 40000 }, DESK);
    const held = engine.act("invoice", id, "issue_invoice", {}, DESK);
    ok("₹40,000 is at or above ₹25,000: held for finance", held.outcome === "held" && held.approval?.approver === "finance" && /₹40,000 is at or above the ₹25,000 threshold/.test(held.entry.summary), held.entry.summary);
    ok("held is not done: still a draft", engine.stateOf("invoice", id) === "draft");
    throws("the requester cannot approve their own", () => engine.decideApproval(held.approval!.id, true, DESK), /cannot also approve/);

    engine.create("staff_member", { full_name: "Meera Pillai", approver_role: "finance" }, DESK);
    engine.create("staff_member", { full_name: "Dr. Suresh", approver_role: "compliance" }, DESK);
    throws("once the team list names approvers, a stranger cannot approve", () => engine.decideApproval(held.approval!.id, true, BOSS), /Ravi is not/);
    throws("nor someone with a different role", () => engine.decideApproval(held.approval!.id, true, "Dr. Suresh"), /may approve compliance decisions, not finance/);
    engine.decideApproval(held.approval!.id, true, "Meera Pillai");
    ok("finance approves: performed, issued", engine.stateOf("invoice", id) === "issued");
    ok("the ledger says who asked and who approved", engine.ledger().some((l) => l.kind === "action" && l.by === DESK && /approved by Meera Pillai/.test(l.summary)));

    const link = engine.act("invoice", id, "issue_payment_link", {}, DESK);
    ok("a link for the full ₹40,000 balance is held too", link.outcome === "held");
    const small = engine.act("invoice", id, "issue_payment_link", { amount: 5000 }, DESK);
    ok("a link for ₹5,000 goes out, as a pending sandbox payment", small.outcome === "performed" && engine.stateOf("payment", small.created!.id) === "pending");
    const pay = engine.store.get(engine.entity("payment"), small.created!.id)!;
    ok("the link is a sandbox address — no build can take money", String(pay.link_url).startsWith("sandbox://pay/"));
    ok("a pending payment does not count as paid", engine.store.get(engine.entity("invoice"), id)!.amount_paid === 0);
    engine.act("payment", small.created!.id, "confirm_payment", { reference: "UPI-123" }, DESK);
    ok("confirmed, it counts — and the invoice is part paid", engine.store.get(engine.entity("invoice"), id)!.amount_paid === 5000 && engine.stateOf("invoice", id) === "part_paid");

    // The approval for the full link was raised when ₹40,000 was owed. Approving it now re-checks.
    engine.act("invoice", id, "record_payment", { amount: 35000, method: "bank_transfer" }, DESK);
    throws("approving a link for an invoice that has since been paid is refused", () => engine.decideApproval(link.approval!.id, true, "Meera Pillai"), /not legal in paid[\s\S]*changed since this was held/);
  }

  // ------------------------------------------------------------------- pipeline
  console.log("\n3. The clinic's own stages, run by the same kernel");
  {
    const { engine } = boot("dental-clinic");
    const p = engine.create("contact", { full_name: "Fatima Shaikh" }, DESK);
    const course = engine.create("work_item", { title: "Root canal, lower left", contact_id: p.id }, DESK);
    const id = String(course.id);
    ok("a treatment course starts in consultation", engine.stateOf("work_item", id) === "consultation");
    const opts = engine.options("work_item", id);
    ok("only what consultation allows is offered", opts.actions.some((a) => a.action === "record_findings") && !opts.actions.some((a) => a.action === "prescribe"));
    ok("the pipeline can be moved by hand; modules cannot", opts.movable && !engine.options("contact", String(p.id)).movable);

    const r1 = engine.act("work_item", id, "prescribe", { medication: "Amoxicillin" }, DESK);
    ok("prescribing in consultation is illegal in that state", r1.outcome === "refused" && /not legal in consultation/.test(r1.entry.summary));
    const early = engine.act("work_item", id, "propose_treatment_plan", {}, DESK);
    ok("proposing a plan before consultation's requirements are met is refused, not queued", early.outcome === "refused" && /2 requirement\(s\) unmet/.test(early.entry.summary));
    engine.setRequirement("work_item", id, "medical history recorded", true, DESK);
    engine.setRequirement("work_item", id, "consent to examine", true, DESK);
    const plan = engine.act("work_item", id, "propose_treatment_plan", {}, DESK);
    ok("with them met, a treatment plan is held for compliance", plan.outcome === "held" && plan.approval?.approver === "compliance");
    engine.setRequirement("work_item", id, "consent to examine", false, DESK);
    throws("consent withdrawn while it waited: approval is refused", () => engine.decideApproval(plan.approval!.id, true, "Dr. Rao"), /1 requirement\(s\) unmet/);
    engine.setRequirement("work_item", id, "consent to examine", true, DESK);
    engine.decideApproval(plan.approval!.id, true, "Dr. Rao");
    ok("consent back on file, approval moves it to treatment plan", engine.stateOf("work_item", id) === "treatment_plan");

    const dr = engine.create("resource", { name: "Dr. Rao — chair 1", kind: "chair" }, DESK);
    const visit = engine.act("work_item", id, "book_next_visit", { starts_at: "2026-10-12T05:00:00.000Z", duration_minutes: 45 }, DESK);
    ok("a custom pipeline action books into the appointments module", visit.created?.entity === "appointment");
    const appt = engine.store.get(engine.entity("appointment"), visit.created!.id)!;
    ok("the booking points back at the course and its end is worked out", appt.work_item_id === id && appt.ends_at === "2026-10-12T05:45:00.000Z", appt);
    ok("its display name reads the patient through the link", String(appt.display_name).startsWith("Fatima Shaikh"));

    engine.update("appointment", visit.created!.id, { resource_id: dr.id }, DESK);
    throws("the same chair cannot be booked twice at once", () => engine.create("appointment", { contact_id: p.id, resource_id: dr.id, starts_at: "2026-10-12T05:30:00.000Z", duration_minutes: 30 }, DESK), /already booked/);
    engine.act("appointment", visit.created!.id, "cancel_appointment", { reason: "patient travelling" }, DESK);
    const again = engine.create("appointment", { contact_id: p.id, resource_id: dr.id, starts_at: "2026-10-12T05:30:00.000Z", duration_minutes: 30 }, DESK);
    ok("a cancelled booking frees the chair", !!again.id);

    engine.update("contact", String(p.id), { full_name: "Fatima S. Shaikh" }, DESK);
    ok("renaming the patient renames what reads them", String(engine.store.get(engine.entity("appointment"), String(again.id))!.display_name).startsWith("Fatima S. Shaikh"));

    engine.act("contact", String(p.id), "mark_do_not_contact", {}, DESK);
    const msg = engine.create("message", { contact_id: p.id, channel: "sms", body: "Your visit is confirmed" }, DESK);
    const sent = engine.act("message", String(msg.id), "send_message", {}, DESK);
    ok("a message to someone who opted out is refused, whoever sends it", sent.outcome === "refused" && /asked not to be contacted/.test(sent.entry.summary));
  }

  // ------------------------------------------------------------------- quotes
  console.log("\n4. A quote becomes an invoice, line for line");
  {
    const { engine } = boot("dental-clinic");
    const p = engine.create("contact", { full_name: "Neha Gupta" }, DESK);
    const q = engine.create("quote", { title: "Braces — 18 months", contact_id: p.id, discount_pct: 20 }, DESK);
    const id = String(q.id);
    engine.create("quote_line", { quote_id: id, description: "Brackets", quantity: 1, unit_price: 30000 }, DESK);
    engine.create("quote_line", { quote_id: id, description: "Adjustment visits", quantity: 6, unit_price: 1500, tax_rate: 18 }, DESK);
    const row = engine.store.get(engine.entity("quote"), id)!;
    ok("subtotal 39,000, discount 7,800, tax 1,296, total 32,496", row.subtotal === 39000 && row.discount_amount === 7800 && row.tax_amount === 1296 && row.total === 32496, row);
    const held = engine.act("quote", id, "send_quote", {}, DESK);
    ok("a 20% discount is beyond the clinic's 15%: held for the desk", held.outcome === "held" && /20% is beyond the 15% policy limit/.test(held.entry.summary));
    engine.update("quote", id, { discount_pct: 10 }, DESK);
    engine.decideApproval(held.approval!.id, false, BOSS);
    const sent = engine.act("quote", id, "send_quote", {}, DESK);
    ok("at 10% it is sent, and stands for the default 15 days", sent.outcome === "performed" && engine.store.get(engine.entity("quote"), id)!.valid_until === "2026-10-25");
    engine.act("quote", id, "accept_quote", {}, DESK);
    const conv = engine.act("quote", id, "convert_quote_to_invoice", {}, DESK);
    const inv = engine.store.get(engine.entity("invoice"), conv.created!.id)!;
    const lines = engine.store.rows(engine.entity("invoice_line")).filter((l) => l.invoice_id === inv.id);
    ok("the invoice is made from the quote, as a draft", engine.stateOf("invoice", String(inv.id)) === "draft" && inv.quote_id === id && inv.subject === "Braces — 18 months");
    ok("every line is copied and the totals agree", lines.length === 2 && inv.total === engine.store.get(engine.entity("quote"), id)!.total, [lines.length, inv.total]);
    ok("the quote is marked invoiced", engine.stateOf("quote", id) === "invoiced");
  }

  // ------------------------------------------------------------------- time
  console.log("\n5. The clock moves things: overdue, lapsed, expired");
  {
    const { engine } = boot("law-firm");
    const c = engine.create("contact", { full_name: "Vivek Anand" }, DESK);
    const inv = engine.create("invoice", { subject: "Advice on lease", contact_id: c.id }, DESK);
    engine.create("invoice_line", { invoice_id: inv.id, description: "Advice", quantity: 2, unit_price: 5000 }, DESK);
    engine.act("invoice", String(inv.id), "issue_invoice", {}, DESK);
    ok("the firm's 30-day terms", engine.store.get(engine.entity("invoice"), String(inv.id))!.due_date === "2026-11-09");
    const deadline = engine.create("commitment", { title: "File written statement", owner: "R. Raghavan", due_at: "2026-10-12T06:30:00.000Z" }, DESK);
    now = new Date("2026-10-10T10:00:00.000Z");
    engine.sweep();
    ok("a deadline inside three days turns at risk", engine.stateOf("commitment", String(deadline.id)) === "at_risk");
    now = new Date("2026-11-15T04:30:00.000Z");
    const swept = engine.sweep();
    ok("past its due date, the invoice is overdue", engine.stateOf("invoice", String(inv.id)) === "overdue" && swept.moved >= 2);
    ok("past the deadline, the commitment is missed", engine.stateOf("commitment", String(deadline.id)) === "missed");
    const f = engine.act("commitment", String(deadline.id), "fulfil_commitment", { evidence: "filed late" }, DESK);
    ok("a missed commitment cannot be quietly fulfilled", f.outcome === "refused");
    now = new Date("2026-10-10T04:30:00.000Z");
  }

  // ------------------------------------------------------------------- capacity, memberships
  console.log("\n6. A gym: full classes, session credits");
  {
    const { engine } = boot("mma-gym");
    const members = ["Arun", "Bala", "Chitra"].map((n) => engine.create("contact", { full_name: n }, DESK));
    const cls = engine.create("session", { name: "Saturday BJJ", starts_at: "2026-10-11T02:30:00.000Z", capacity: 2 }, DESK);
    const res = members.map((m) => engine.create("reservation", { session_id: cls.id, contact_id: m.id, seats: 1 }, DESK));
    engine.act("reservation", String(res[0].id), "confirm_reservation", {}, DESK);
    engine.act("reservation", String(res[1].id), "confirm_reservation", {}, DESK);
    ok("seats are counted from confirmed bookings", engine.store.get(engine.entity("session"), String(cls.id))!.seats_left === 0);
    const third = engine.act("reservation", String(res[2].id), "confirm_reservation", {}, DESK);
    ok("the third is refused: the class is full", third.outcome === "refused" && /not enough places/.test(third.entry.summary));
    engine.act("reservation", String(res[2].id), "waitlist_reservation", {}, DESK);
    engine.act("reservation", String(res[0].id), "cancel_reservation", { reason: "injured" }, DESK);
    const later = engine.act("reservation", String(res[2].id), "confirm_reservation", {}, DESK);
    ok("a cancellation frees a place for the waitlist", later.outcome === "performed" && engine.store.get(engine.entity("session"), String(cls.id))!.seats_left === 0);

    const plan = engine.create("plan", { name: "8-class pack", price: 4000, duration_days: 30, sessions_included: 2 }, DESK);
    const ms = engine.create("membership", { contact_id: members[0].id, plan_id: plan.id }, DESK);
    const mid = String(ms.id);
    ok("a membership's name reads its member and plan", engine.store.get(engine.entity("membership"), mid)!.display_name === "Arun · 8-class pack");
    engine.act("membership", mid, "activate_membership", {}, DESK);
    const m1 = engine.store.get(engine.entity("membership"), mid)!;
    ok("activating starts a 30-day term today", m1.start_date === "2026-10-10" && m1.end_date === "2026-11-09" && m1.sessions_left === 2, m1);
    engine.act("membership", mid, "record_session_use", {}, DESK);
    engine.act("membership", mid, "record_session_use", {}, DESK);
    const over = engine.act("membership", mid, "record_session_use", {}, DESK);
    ok("the third session on a two-session plan is refused", over.outcome === "refused" && /no sessions left/.test(over.entry.summary));
    const cancel = engine.act("membership", mid, "cancel_membership", { reason: "moving city" }, DESK);
    ok("cancelling asks the head coach, with the gym's own reason", cancel.outcome === "held" && /head coach/.test(cancel.entry.summary));
  }

  // ------------------------------------------------------------------- stock
  console.log("\n7. A salon's stock is counted, not typed");
  {
    const { engine } = boot("salon");
    const shampoo = engine.create("stock_item", { name: "Keratin shampoo 1L", reorder_level: 3 }, DESK);
    const id = String(shampoo.id);
    engine.act("stock_item", id, "receive_stock", { quantity: 10 }, DESK);
    engine.act("stock_item", id, "use_stock", { quantity: 3, note: "Booking SAL-APP-0001" }, DESK);
    ok("on hand is the sum of movements: 10 in, 3 out", engine.store.get(engine.entity("stock_item"), id)!.on_hand === 7);
    const over = engine.act("stock_item", id, "use_stock", { quantity: 9 }, DESK);
    ok("taking more than is on hand is refused", over.outcome === "refused" && /not enough on hand/.test(over.entry.summary));
    const adj = engine.act("stock_item", id, "adjust_stock", { quantity: -2, reason: "stock-take" }, DESK);
    ok("a manual adjustment waits for a person", adj.outcome === "held" && engine.store.get(engine.entity("stock_item"), id)!.on_hand === 7);
    ok("reordering is not offered: this salon does not buy through the app", !engine.options("stock_item", id).actions.some((a) => a.action === "request_reorder"));
  }

  // ------------------------------------------------------------------- sample data
  console.log("\n8. Sample data, through the engine");
  for (const ex of ["dental-clinic", "mma-gym", "law-firm", "salon"]) {
    const { app, engine } = boot(ex);
    const r = seedComposed(app, engine, DESK);
    const primaryRows = engine.store.rows(engine.primary).length;
    ok(`${ex}: sample rows are made for the board, with nothing refused`, primaryRows >= 6 && Object.keys(r.skipped).length === 0, r.skipped);
    const states = new Set(engine.store.rows(engine.primary).map((x) => engine.stateOf(engine.primary.name, String(x.id))));
    ok(`${ex}: spread across the board's stages`, states.size >= 3, [...states]);
    throws(`${ex}: and only into an empty app`, () => seedComposed(app, engine, DESK), /already has records/);
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} engine check(s) FAILED` : "\nAll engine checks passed.");
if (failures) process.exit(1);
