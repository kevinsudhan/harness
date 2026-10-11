/**
 * The kernel, running a composed business.
 *
 * The app-runtime engine runs one lifecycle — the primary table's. A composed business has
 * one per entity with stages: the clinic's treatment course, but also every invoice, every
 * appointment, every membership. Each runs on the kernel unchanged (domain/machine.ts for
 * legality and moves, domain/policy.ts for approvals), through a machine built from the
 * modules' actions (manifest.ts). Every action asks the same questions, in the template's
 * order, and a refusal says which one failed:
 *
 *   legal?     is the action allowed in the record's current state            (machine.can)
 *   possible?  does its guard hold — seats left, enough stock, not opted out  (formula)
 *   allowed?   may it happen now, or does a person approve it first           (decideFor)
 *
 * Then it is performed from the module's declaration alone — rows it creates, fields it
 * writes, the state it moves to — and every computed field it touches is recomputed, up
 * through whatever the record points at. That is how an invoice settles itself: a payment
 * row is created, the invoice's `amount_paid` is a sum over its payments, and its own
 * automatic move takes it to paid. No module carries code for any of it.
 *
 * The ledger, the approvals queue and their rules are the template's: append-only; held
 * actions wait for a person who is not the requester; approving re-checks everything.
 */
import { randomUUID } from "node:crypto";
import * as machine from "../domain/machine.js";
import { decideFor, type Verdict } from "../domain/policy.js";
import type { AppAction, AppColumn, AppEntity, AppManifest } from "../builder/appManifest.js";
import type { VerticalConfig } from "../verticals/types.js";
import { coerce, coerceRow, type Row, type Store } from "../app-runtime/store.js";
import { EngineError, type Approval, type LedgerEntry } from "../app-runtime/engine.js";
import { machineFor } from "./manifest.js";
import { compiled, references, run, truthy, valueOf, type Scope } from "./formula.js";
import { storageOf, humanize } from "./compose.js";
import { moduleById } from "./catalog/index.js";

export type Twin = machine.MachineTwin & { recordId: string };

export interface ActionOption {
  action: string;
  label: string;
  summary: string;
  effects: AppAction["effects"];
  params: NonNullable<AppAction["params"]>;
  policy: AppAction["policy"];
  custom: boolean;
  /** What the gate would say if it were taken now, before any params are typed in. */
  verdict: Verdict;
}

export interface Options {
  entity: string;
  state: string | null;
  label: string | null;
  readiness: number;
  requirements: Record<string, boolean>;
  unmet: string[];
  next: Array<{ state: string; label: string }>;
  /** Whether a person may move it by hand. Only the business's own pipeline; modules move by their actions. */
  movable: boolean;
  actions: ActionOption[];
  history: machine.MachineTwin["history"];
  pendingApprovals: Approval[];
}

export interface ActResult {
  outcome: "performed" | "held" | "refused";
  entry: LedgerEntry;
  approval?: Approval;
  /** The row the action made, when it made one. */
  created?: { entity: string; id: string };
}

const blank = (x: unknown) => x === null || x === undefined || x === "";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const human = (a: string) => a.replace(/_/g, " ");

export class ModuleEngine {
  readonly primary: AppEntity;
  readonly prefix: string;
  private readonly actionList: AppAction[];
  private machines = new Map<string, VerticalConfig>();
  /** entity → the entities whose stored formulas read it through a link (a membership's name reads its member's). */
  private readers = new Map<string, Array<{ entity: string; link: string }>>();

  /** Told about every ledger entry after it is written. */
  onRecord?: (entry: LedgerEntry) => void;

  constructor(readonly app: AppManifest, readonly store: Store, private clock: () => Date = () => new Date()) {
    if (app.version !== 2 || !app.actions) throw new Error("ModuleEngine runs composed apps (app.json version 2)");
    this.actionList = app.actions;
    this.primary = this.entity(app.primary.entity);
    this.prefix = app.vertical.id.replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() || "APP";

    for (const e of app.entities) {
      for (const c of e.columns) {
        if (!c.formula) continue;
        for (const r of references(compiled(c.formula))) {
          if (r.kind !== "path" || r.path.length < 2) continue;
          const link = e.columns.find((x) => x.name === r.path[0] && x.links);
          if (!link) continue;
          const list = this.readers.get(link.links!) ?? [];
          if (!list.some((x) => x.entity === e.name && x.link === link.name)) list.push({ entity: e.name, link: link.name });
          this.readers.set(link.links!, list);
        }
      }
    }
  }

  // --------------------------------------------------------------------- lookups

  entity(name: string): AppEntity {
    const e = this.app.entities.find((x) => x.name === name);
    if (!e) throw new EngineError(`no entity ${name}`);
    return e;
  }

  private maybe(name: string): AppEntity | undefined {
    return this.app.entities.find((x) => x.name === name);
  }

  actionsOn(entity: string): AppAction[] {
    return this.actionList.filter((a) => a.entity === entity);
  }

  machine(entity: string): VerticalConfig {
    let m = this.machines.get(entity);
    if (!m) {
      const e = this.entity(entity);
      m = machineFor({ name: e.name, label: e.label, lifecycle: e.lifecycle }, this.actionList, this.app.business);
      this.machines.set(entity, m);
    }
    return m;
  }

  settingsOf(module: string | undefined): Record<string, unknown> {
    return this.app.modules?.find((m) => m.id === module)?.settings ?? {};
  }

  private singular(e: AppEntity) {
    return e.singular ?? e.label.replace(/s$/, "");
  }

  private today(): string {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: this.app.business.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(this.clock());
    } catch {
      return this.clock().toISOString().slice(0, 10);
    }
  }

  /** Each link's target, by its title — so a list says "Kavya Menon", not DEN-CON-0001. */
  linkLabels(e: AppEntity, r: Row): Record<string, string> {
    return Object.fromEntries(
      e.columns
        .filter((c) => c.links && !blank(r[c.name]))
        .map((c) => {
          const t = this.maybe(c.links!);
          const target = t ? this.store.get(t, String(r[c.name])) : undefined;
          return [c.name, target && t ? String(target[t.title] ?? r[c.name]) : String(r[c.name])];
        }),
    );
  }

  /** A row as it is shown: with its links' names, and its stage and readiness when it has stages. */
  decorate(e: AppEntity, r: Row): Row {
    const out: Row = { ...r, _labels: this.linkLabels(e, r) };
    if (e.lifecycle) {
      const t = this.twin(e.name, String(r.id));
      const reqs = t ? Object.values(t.requirements) : [];
      out._state = t?.state ?? null;
      out._readiness = reqs.length ? Math.round((reqs.filter(Boolean).length / reqs.length) * 100) : 100;
    }
    return out;
  }

  // ---------------------------------------------------------------------- ledger

  ledger(): LedgerEntry[] {
    return this.store.read<LedgerEntry[]>("_ledger", []);
  }

  private record(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
    const entry: LedgerEntry = { id: randomUUID().slice(0, 8), at: this.clock().toISOString(), ...e };
    this.store.write("_ledger", [...this.ledger(), entry]);
    try { this.onRecord?.(entry); } catch { /* a listener never undoes a write */ }
    return entry;
  }

  note(summary: string, by: string): void {
    this.record({ by, kind: "sample", entity: this.primary.name, recordId: null, summary });
  }

  approvals(): Approval[] {
    return this.store.read<Approval[]>("_approvals", []);
  }

  // ----------------------------------------------------------------------- twins

  private twins(entity: string): Record<string, Twin> {
    return this.store.read<Record<string, Twin>>(`_twins.${entity}`, {});
  }

  twin(entity: string, id: string): Twin | null {
    return this.twins(entity)[id] ?? null;
  }

  stateOf(entity: string, id: string): string | null {
    return this.twin(entity, id)?.state ?? null;
  }

  private saveTwin(e: AppEntity, t: Twin): void {
    this.store.write(`_twins.${e.name}`, { ...this.twins(e.name), [t.recordId]: t });
    if (e.stageColumn) this.store.update(e, t.recordId, { [e.stageColumn]: t.state });
  }

  // ---------------------------------------------------------------------- formulas

  /** A record as formulas see it: its fields, its links followed, its child rows, the action's params. */
  scope(e: AppEntity, row: Row, extra: { params?: Record<string, unknown>; actor?: string; created?: string | null } = {}): Scope {
    const self = this;
    return {
      get(path) {
        const [head, ...rest] = path;
        if (head === "param" && rest.length === 1) return extra.params?.[rest[0]] ?? null;
        if (head === "setting" && rest.length === 1) return self.settingsOf(e.module)[rest[0]] ?? null;
        if (head === "state" && rest.length === 0) return e.lifecycle && !blank(row.id) ? self.stateOf(e.name, String(row.id)) : null;
        const value = row[head];
        if (!rest.length) return value ?? null;
        const col = e.columns.find((c) => c.name === head);
        const target = col?.links ? self.maybe(col.links) : undefined;
        if (!target || blank(value)) return null;
        const linked = self.store.get(target, String(value));
        return linked ? self.scope(target, linked).get(rest) : null;
      },
      children(entity) {
        const child = self.maybe(entity);
        const link = child?.columns.find((c) => c.links === e.name);
        if (!child || !link || blank(row.id)) return [];
        return self.store.rows(child).filter((r) => String(r[link.name]) === String(row.id)).map((r) => self.scope(child, r, extra));
      },
      today: () => self.today(),
      now: () => self.clock().toISOString(),
      actor: () => extra.actor ?? "",
      id: () => String(row.id ?? ""),
      created: () => extra.created ?? null,
    };
  }

  private fit(c: AppColumn, v: unknown): unknown {
    if (blank(v)) return null;
    if (c.type === "numeric" || c.type === "integer") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return c.type === "integer" ? Math.round(n) : c.semantic === "money" ? Math.round(n * 100) / 100 : n;
    }
    if (c.type === "boolean") return truthy(v);
    if (c.type === "date") return String(v).slice(0, 10);
    return String(v);
  }

  /** The row with every computed field worked out, in the order they are declared — later ones read earlier ones. */
  private compute(e: AppEntity, row: Row): Row {
    const out = { ...row };
    for (const c of e.columns) {
      if (!c.formula) continue;
      let v: unknown;
      try {
        v = run(c.formula, this.scope(e, out));
      } catch {
        v = null;
      }
      out[c.name] = this.fit(c, v);
    }
    return out;
  }

  private refresh(e: AppEntity, id: string): void {
    const row = this.store.get(e, id);
    if (!row) return;
    const next = this.compute(e, row);
    const patch: Row = {};
    for (const c of e.columns) if (c.formula && !same(row[c.name], next[c.name])) patch[c.name] = next[c.name];
    if (Object.keys(patch).length) this.store.update(e, id, patch);
  }

  /** Moves the record makes on its own once a condition holds — at most a few, so a bad pair of rules cannot loop. */
  private autoMove(e: AppEntity, id: string): void {
    const rules = e.lifecycle?.auto;
    if (!rules?.length) return;
    for (let i = 0; i < 6; i++) {
      const t = this.twin(e.name, id);
      const row = this.store.get(e, id);
      if (!t || !row) return;
      const scope = this.scope(e, row);
      const rule = rules.find((r) => {
        if (!r.from.includes(t.state)) return false;
        try { return truthy(run(r.if, scope)); } catch { return false; }
      });
      if (!rule) return;
      let next: Twin;
      try {
        next = machine.advance(this.machine(e.name), t, rule.to, `automatic: ${rule.if}`, { force: true });
      } catch {
        return;
      }
      this.saveTwin(e, next);
      this.record({ by: "system", kind: "advanced", entity: e.name, recordId: id, from: t.state, to: rule.to, summary: `${t.state} → ${rule.to} on its own (${rule.if})` });
    }
  }

  /**
   * After any write: recompute the record, make its automatic moves, then do the same for
   * whatever it points at (a payment's invoice, a line's quote) and for whatever reads it
   * through a link (a member renamed renames their membership).
   */
  private settle(e: AppEntity, id: string, depth = 0): void {
    this.refresh(e, id);
    this.autoMove(e, id);
    if (depth >= 3) return;
    const row = this.store.get(e, id);
    if (!row) return;
    for (const c of e.columns) {
      if (!c.links || blank(row[c.name]) || c.links === e.name) continue;
      const parent = this.maybe(c.links);
      if (parent) this.settle(parent, String(row[c.name]), depth + 1);
    }
    for (const r of this.readers.get(e.name) ?? []) {
      const reader = this.entity(r.entity);
      for (const x of this.store.rows(reader)) {
        if (String(x[r.link]) !== id) continue;
        this.refresh(reader, String(x.id));
        this.autoMove(reader, String(x.id));
      }
    }
  }

  /** Every record with time-based moves, checked against the clock — overdue invoices, lapsed memberships, missed deadlines. */
  sweep(): { checked: number; moved: number } {
    const before = this.ledger().length;
    let checked = 0;
    for (const e of this.app.entities) {
      if (!e.lifecycle?.auto?.length && !e.columns.some((c) => c.formula?.includes("today()") || c.formula?.includes("now()"))) continue;
      for (const r of this.store.rows(e)) {
        checked++;
        this.refresh(e, String(r.id));
        this.autoMove(e, String(r.id));
      }
    }
    return { checked, moved: this.ledger().length - before };
  }

  // ---------------------------------------------------------------------- records

  /** What a person typed, checked against the entity: real fields, not computed ones, valid choices, links that exist. */
  private input(e: AppEntity, values: Row, existing: Row | null, trusted: boolean): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      const c = e.columns.find((x) => x.name === k);
      if (!c) throw new EngineError(`${e.label} has no field "${k}"`);
      if (c.pk || k === "created_at" || k === "updated_at") continue;
      if (c.formula) {
        if (trusted) continue;
        throw new EngineError(`${c.label ?? k} is worked out by the system, not typed in`);
      }
      if (k === e.stageColumn) throw new EngineError("the stage moves through the record's actions, not as a field");
      out[k] = v;
    }
    for (const [k, v] of Object.entries(out)) {
      if (blank(v)) continue;
      const c = e.columns.find((x) => x.name === k)!;
      if (c.semantic === "choice" && c.options && !c.options.includes(String(v))) {
        throw new EngineError(`${c.label ?? k} must be one of: ${c.options.join(", ")}`);
      }
      if (c.links) {
        const target = this.maybe(c.links);
        if (target && !this.store.get(target, String(v))) throw new EngineError(`there is no ${this.singular(target).toLowerCase()} ${v}`);
      }
    }
    const merged = { ...(existing ?? {}), ...out };
    const missing = e.columns.filter((c) => c.required && !c.formula && blank(merged[c.name]));
    if (missing.length) throw new EngineError(`${this.singular(e)} needs ${missing.map((c) => c.label ?? c.name).join(", ")}`);
    return out;
  }

  /** Two live bookings of one resource at once are refused, whoever makes them. */
  private checkOverlap(e: AppEntity, row: Row, selfId: string | null, state: string | null): void {
    const o = e.noOverlap;
    if (!o || (state && o.except.includes(state))) return;
    const res = row[o.resource];
    const s = Date.parse(String(row[o.start] ?? ""));
    const en = Date.parse(String(row[o.end] ?? ""));
    if (blank(res) || Number.isNaN(s) || Number.isNaN(en)) return;
    for (const other of this.store.rows(e)) {
      if (String(other.id) === selfId || String(other[o.resource]) !== String(res)) continue;
      const st = this.stateOf(e.name, String(other.id));
      if (st && o.except.includes(st)) continue;
      const os = Date.parse(String(other[o.start] ?? ""));
      const oe = Date.parse(String(other[o.end] ?? ""));
      if (s < oe && os < en) {
        const target = this.maybe(e.columns.find((c) => c.name === o.resource)?.links ?? "");
        const name = target ? this.store.get(target, String(res))?.[target.title] ?? res : res;
        throw new EngineError(`${name} is already booked then — ${other[e.title] ?? other.id} (${other.id})`);
      }
    }
  }

  create(entity: string, values: Row, by: string, opts: { state?: string; trusted?: boolean } = {}): Row {
    const e = this.entity(entity);
    const clean = this.input(e, values, null, !!opts.trusted);
    const state = e.lifecycle ? opts.state ?? e.lifecycle.initial : null;
    if (state && e.lifecycle && !opts.trusted && state !== e.lifecycle.initial && !e.lifecycle.entry?.includes(state)) {
      throw new EngineError(`a new ${this.singular(e).toLowerCase()} cannot start as ${state}`);
    }
    this.checkOverlap(e, this.compute(e, coerceRow(e, clean)), null, state);
    const row = this.store.insert(e, clean, this.prefix);
    const id = String(row[e.key]);
    if (state) this.saveTwin(e, { ...machine.startTwin(this.machine(e.name), state), recordId: id });
    this.record({ by, kind: "created", entity: e.name, recordId: id, summary: `${this.singular(e)} ${id} created${state && state !== e.lifecycle!.initial ? ` as ${state}` : ""}` });
    this.settle(e, id);
    return this.store.get(e, id)!;
  }

  update(entity: string, id: string, values: Row, by: string): Row {
    const e = this.entity(entity);
    const row = this.store.get(e, id);
    if (!row) throw new EngineError(`no ${this.singular(e).toLowerCase()} ${id}`);
    const clean = this.input(e, values, row, false);
    if (!Object.keys(clean).length) return row;
    this.checkOverlap(e, this.compute(e, { ...row, ...coerceRow(e, clean) }), id, this.stateOf(e.name, id));
    this.store.update(e, id, clean);
    this.record({ by, kind: "updated", entity: e.name, recordId: id, summary: `${Object.keys(clean).map((k) => e.columns.find((c) => c.name === k)?.label ?? k).join(", ")} updated` });
    this.settle(e, id);
    return this.store.get(e, id)!;
  }

  /** Places a record in a state, for sample data only — recorded as such. */
  placeSample(entity: string, id: string, state: string): void {
    const e = this.entity(entity);
    const t: Twin = { ...machine.startTwin(this.machine(e.name), state), recordId: id };
    t.history = [{ from: null, to: state, at: t.updatedAt, why: "sample data" }];
    this.saveTwin(e, t);
    this.settle(e, id);
  }

  // -------------------------------------------------------------------- lifecycle

  /** Only the business's own pipeline is moved by hand; a module's records move by its actions. */
  movable(entity: string): boolean {
    const e = this.entity(entity);
    return !!e.lifecycle && moduleById(e.module ?? "")?.extensible === e.name;
  }

  options(entity: string, id: string): Options {
    const e = this.entity(entity);
    const row = this.store.get(e, id);
    if (!row) throw new EngineError(`no ${this.singular(e).toLowerCase()} ${id}`);
    const t = e.lifecycle ? this.twin(e.name, id) : null;
    const st = t ? e.lifecycle!.states[t.state] : null;
    const m = this.machine(e.name);
    const legal = this.actionsOn(e.name).filter((a) => !t || machine.can(m, t.state, a.name).ok);
    return {
      entity: e.name,
      state: t?.state ?? null,
      label: st?.label ?? null,
      readiness: t ? machine.readiness(t) : 100,
      requirements: t?.requirements ?? {},
      unmet: t ? machine.unmetRequirements(t) : [],
      next: st ? st.next.map((s) => ({ state: s, label: e.lifecycle!.states[s]?.label ?? s })) : [],
      movable: this.movable(e.name),
      actions: legal.map((a) => {
        let verdict: Verdict;
        try {
          const ms = this.measure(e, row, a, {}, "");
          verdict = decideFor(m, a.name, { amountInr: ms.amount, discountPct: ms.discountPct });
        } catch {
          verdict = decideFor(m, a.name, {});
        }
        return { action: a.name, label: a.label, summary: a.summary, effects: a.effects, params: a.params ?? [], policy: a.policy, custom: !!a.custom, verdict };
      }),
      history: t?.history ?? [],
      pendingApprovals: this.approvals().filter((a) => a.entity === e.name && a.recordId === id && a.status === "pending"),
    };
  }

  setRequirement(entity: string, id: string, requirement: string, met: boolean, by: string): Twin {
    const e = this.entity(entity);
    const t = this.twin(e.name, id);
    if (!t) throw new EngineError(`${this.singular(e)} ${id} has no stages`);
    const next = machine.setRequirement(t, requirement, met);
    this.saveTwin(e, next);
    this.record({ by, kind: "requirement", entity: e.name, recordId: id, summary: `${met ? "met" : "reopened"}: ${requirement}` });
    return next;
  }

  advance(entity: string, id: string, to: string, why: string, force: boolean, by: string): Twin {
    const e = this.entity(entity);
    const before = this.twin(e.name, id);
    if (!before) throw new EngineError(`${this.singular(e)} ${id} has no stages`);
    if (!this.movable(e.name)) {
      const reason = `${e.label.toLowerCase()} move through their actions, not by hand`;
      this.record({ by, kind: "refused", entity: e.name, recordId: id, from: before.state, to, summary: reason });
      throw new EngineError(reason);
    }
    let t: Twin;
    try {
      t = machine.advance(this.machine(e.name), before, to, why || `moved by ${by}`, { force });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.record({ by, kind: "refused", entity: e.name, recordId: id, from: before.state, to, summary: reason });
      throw new EngineError(reason);
    }
    this.saveTwin(e, t);
    this.record({ by, kind: "advanced", entity: e.name, recordId: id, from: before.state, to, summary: `${before.state} → ${to}${force ? ` (forced past: ${machine.unmetRequirements(before).join(", ")})` : ""}` });
    this.settle(e, id);
    return t;
  }

  // ----------------------------------------------------------------------- actions

  private params(a: AppAction, raw: Record<string, unknown> = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of a.params ?? []) {
      const label = p.label ?? humanize(p.name);
      const v = raw[p.name];
      if (blank(v)) {
        if (p.required) throw new EngineError(`${a.label} needs ${label.toLowerCase()}`);
        out[p.name] = null;
        continue;
      }
      let val: unknown;
      try {
        val = coerce({ name: label, type: storageOf(p.type) }, v);
      } catch (err) {
        throw new EngineError(err instanceof Error ? err.message : String(err));
      }
      if (p.type === "choice" && p.options && !p.options.includes(String(val))) throw new EngineError(`${label} must be one of: ${p.options.join(", ")}`);
      if (p.type === "ref" && p.ref) {
        const target = this.maybe(p.ref);
        if (target && !this.store.get(target, String(val))) throw new EngineError(`there is no ${this.singular(target).toLowerCase()} ${val}`);
      }
      out[p.name] = val;
    }
    return out;
  }

  private measure(e: AppEntity, row: Row, a: AppAction, params: Record<string, unknown>, by: string): { amount?: number; discountPct?: number } {
    const s = this.scope(e, row, { params, actor: by });
    const num = (src?: string) => {
      if (!src) return undefined;
      const v = run(src, s);
      const n = Number(v);
      return blank(v) || !Number.isFinite(n) ? undefined : n;
    };
    return { amount: num(a.measure?.amount), discountPct: num(a.measure?.discountPct) };
  }

  /** Legal in this state, able to move where it goes, and its guard holds. */
  private check(e: AppEntity, id: string, a: AppAction, params: Record<string, unknown>, by: string): { ok: true } | { ok: false; reason: string } {
    const row = this.store.get(e, id);
    if (!row) return { ok: false, reason: `${this.singular(e)} ${id} no longer exists` };
    if (e.lifecycle) {
      const t = this.twin(e.name, id);
      if (!t) return { ok: false, reason: `${this.singular(e)} ${id} has no stages` };
      const legal = machine.can(this.machine(e.name), t.state, a.name);
      if (!legal.ok) return legal;
      if (a.to && a.to !== t.state) {
        try {
          machine.advance(this.machine(e.name), t, a.to, "check");
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    if (a.guard) {
      let pass: boolean;
      try {
        pass = truthy(run(a.guard.if, this.scope(e, row, { params, actor: by })));
      } catch (err) {
        return { ok: false, reason: `could not check whether it is possible: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!pass) return { ok: false, reason: a.guard.else };
    }
    return { ok: true };
  }

  /**
   * Takes an action on a record. Performed, held for a person, or refused — and the
   * ledger says which, and why. Bad input (a missing param, a wrong type) is an error,
   * not a refusal: nothing was attempted.
   */
  act(entity: string, id: string, action: string, raw: Record<string, unknown>, by: string): ActResult {
    const e = this.entity(entity);
    const a = this.actionsOn(e.name).find((x) => x.name === action);
    if (!a) throw new EngineError(`${e.label} have no action "${action}" in this business`);
    if (!this.store.get(e, id)) throw new EngineError(`no ${this.singular(e).toLowerCase()} ${id}`);
    const params = this.params(a, raw);

    const check = this.check(e, id, a, params, by);
    if (!check.ok) {
      const entry = this.record({ by, kind: "refused", entity: e.name, recordId: id, action: a.name, params, summary: `${a.label} refused — ${check.reason}` });
      return { outcome: "refused", entry };
    }

    const row = this.store.get(e, id)!;
    const ms = this.measure(e, row, a, params, by);
    const verdict = decideFor(this.machine(e.name), a.name, { amountInr: ms.amount, discountPct: ms.discountPct });
    if (verdict.autonomy === "approve") {
      const approval: Approval = {
        id: randomUUID().slice(0, 8),
        at: this.clock().toISOString(),
        requestedBy: by,
        entity: e.name,
        recordId: id,
        action: a.name,
        context: { amount: ms.amount, discountPct: ms.discountPct },
        params,
        why: verdict.why,
        approver: verdict.approver,
        status: "pending",
      };
      this.store.write("_approvals", [...this.approvals(), approval]);
      const entry = this.record({ by, kind: "held", entity: e.name, recordId: id, action: a.name, verdict, params, summary: `${a.label} held for ${verdict.approver} — ${verdict.why}` });
      return { outcome: "held", entry, approval };
    }
    return this.perform(e, id, a, params, by, verdict);
  }

  private perform(e: AppEntity, id: string, a: AppAction, params: Record<string, unknown>, by: string, verdict: Verdict, approvedBy?: string): ActResult {
    let created: { entity: string; id: string } | undefined;
    const c = a.creates;
    if (c) {
      const scope = this.scope(e, this.store.get(e, id)!, { params, actor: by });
      const values = Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, valueOf(v, scope)]));
      const made = this.create(c.entity, values, by, { state: c.state, trusted: true });
      created = { entity: c.entity, id: String(made.id) };
      if (c.children) {
        const from = this.entity(c.children.from);
        const to = this.entity(c.children.to);
        const link = from.columns.find((x) => x.links === e.name)!;
        const back = to.columns.find((x) => x.links === c.entity)!;
        for (const child of this.store.rows(from).filter((r) => String(r[link.name]) === id)) {
          const cs = this.scope(from, child, { params, actor: by });
          if (c.children.where && !truthy(run(c.children.where, cs))) continue;
          const vals = Object.fromEntries(Object.entries(c.children.fields).map(([k, v]) => [k, valueOf(v, cs)]));
          this.create(to.name, { ...vals, [back.name]: created.id }, by, { trusted: true });
        }
      }
    }

    if (a.sets && Object.keys(a.sets).length) {
      const scope = this.scope(e, this.store.get(e, id)!, { params, actor: by, created: created?.id ?? null });
      const values: Row = Object.fromEntries(Object.entries(a.sets).map(([k, v]) => [k, valueOf(v, scope)]));
      const current = this.store.get(e, id)!;
      this.checkOverlap(e, this.compute(e, { ...current, ...coerceRow(e, values) }), id, this.stateOf(e.name, id));
      this.store.update(e, id, values);
    }

    let from: string | undefined;
    let to: string | undefined;
    if (e.lifecycle && a.to) {
      const t = this.twin(e.name, id)!;
      if (t.state !== a.to) {
        this.saveTwin(e, machine.advance(this.machine(e.name), t, a.to, `${a.label} by ${by}`));
        from = t.state;
        to = a.to;
      }
    }

    const said = ["reason", "message", "note", "response", "evidence"].map((k) => params[k]).find((v) => typeof v === "string" && v);
    const entry = this.record({
      by,
      kind: "action",
      entity: e.name,
      recordId: id,
      action: a.name,
      verdict,
      params,
      ...(from ? { from, to } : {}),
      summary: `${a.label}${created ? ` → ${created.entity.replace(/_/g, " ")} ${created.id}` : ""}${said ? ` — ${String(said).slice(0, 120)}` : ""}${approvedBy ? ` (approved by ${approvedBy})` : ""}`,
    });
    this.settle(e, id);
    return { outcome: "performed", entry, ...(created ? { created } : {}) };
  }

  // ---------------------------------------------------------------------- approvals

  /**
   * Who may give an approval. Once the team list names anyone as an approver, the list is
   * the rule: the role must match (an owner may give any), and someone not on it cannot.
   * Before then, any second person can — the requester rule still holds.
   */
  private mayApprove(by: string, approver: string): string | null {
    const staff = this.maybe("staff_member");
    if (!staff) return null;
    const people = this.store.rows(staff);
    const approvers = people.filter((p) => p.approver_role && p.approver_role !== "none" && this.stateOf(staff.name, String(p.id)) !== "left");
    if (!approvers.length) return null;
    const me = approvers.find((p) => String(p.full_name ?? "").trim().toLowerCase() === by.trim().toLowerCase());
    if (!me) return `only someone on the team list with the ${approver} approver role may approve this — ${by} is not`;
    if (me.approver_role !== approver && me.approver_role !== "owner") return `${by} may approve ${me.approver_role} decisions, not ${approver} ones`;
    return null;
  }

  decideApproval(id: string, approve: boolean, by: string): Approval {
    const all = this.approvals();
    const i = all.findIndex((a) => a.id === id);
    if (i < 0) throw new EngineError(`no approval ${id}`);
    const a = all[i];
    if (a.status !== "pending") throw new EngineError(`approval ${id} was already ${a.status}`);
    if (a.requestedBy === by && approve) throw new EngineError("the person who asked for an action cannot also approve it");
    const why = this.mayApprove(by, a.approver);
    if (why) throw new EngineError(why);

    if (approve) {
      const e = this.entity(a.entity);
      const action = this.actionsOn(e.name).find((x) => x.name === a.action);
      if (!action) throw new EngineError(`cannot approve: ${a.action} is no longer offered`);
      const params = a.params ?? {};
      // Re-checked in full: the record may have moved on, been paid, or run out of seats while this waited.
      const check = this.check(e, a.recordId, action, params, a.requestedBy);
      if (!check.ok) throw new EngineError(`cannot approve: ${check.reason} — the record has changed since this was held`);
      const ms = this.measure(e, this.store.get(e, a.recordId)!, action, params, a.requestedBy);
      const verdict = decideFor(this.machine(e.name), action.name, { amountInr: ms.amount, discountPct: ms.discountPct });
      this.perform(e, a.recordId, action, params, a.requestedBy, verdict, by);
    }
    const decided: Approval = { ...a, status: approve ? "approved" : "rejected", decidedBy: by, decidedAt: this.clock().toISOString() };
    const next = [...this.approvals()];
    next[next.findIndex((x) => x.id === id)] = decided;
    this.store.write("_approvals", next);
    const label = this.actionList.find((x) => x.name === a.action)?.label ?? human(a.action);
    this.record({ by, kind: approve ? "approved" : "rejected", entity: a.entity, recordId: a.recordId, action: a.action, summary: `${label} ${approve ? "approved and performed" : "rejected"} (asked by ${a.requestedBy})` });
    return decided;
  }
}
