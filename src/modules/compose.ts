/**
 * Composition — a business config plus the catalogue, in; one checked app, out.
 *
 *   config (what the model wrote)  →  normalise  →  resolve  →  validate  →  ComposedApp
 *
 * Normalising fixes, in code and with a note, the slips that have exactly one right answer:
 * a module needed by another is added, a drop of a field the logic reads is ignored, a
 * custom threshold with no figure to compare gets an `amount` param. Anything that needs
 * judgement — a stage nothing reaches, a formula naming a field that does not exist, an
 * action that would leave a state it cannot leave — is reported as a problem, and a config
 * with problems produces no app. The fork builder's split, kept on purpose: the model's
 * mechanical mistakes are cheaper to fix here than to explain back to it.
 *
 * Everything here is deterministic and free. The same config always composes to the same
 * app, which is what lets a person edit a config by hand and recompose without a model.
 */
import type { ActionDef, EntityDef, FieldDef, FieldType, LifecycleDef, ModuleCategory, ModuleDef, Value } from "./types.js";
import { CATALOG, entityDef as catalogEntity } from "./catalog/index.js";
import { BusinessConfigSchema, type BusinessConfig, type ModuleConfig } from "./config.js";
import { compiled, references, type Reference } from "./formula.js";

export type Storage = "text" | "integer" | "numeric" | "boolean" | "date" | "timestamp with time zone" | "text[]" | "jsonb";

export function storageOf(t: FieldType): Storage {
  switch (t) {
    case "integer": return "integer";
    case "number":
    case "money":
    case "percent": return "numeric";
    case "boolean": return "boolean";
    case "date": return "date";
    case "datetime": return "timestamp with time zone";
    case "tags": return "text[]";
    case "json": return "jsonb";
    default: return "text";
  }
}

export interface ComposedField extends FieldDef {
  label: string;
  storage: Storage;
  /** Added by the business, not shipped by the module. */
  added?: boolean;
}

export interface ComposedEntity {
  name: string;
  module: string;
  label: string;
  singular: string;
  purpose: string;
  title: string;
  /** Every row's id column. Always "id": readable references like DEN-INV-0004. */
  key: "id";
  /** The short code in its references: INV, IL, PO. */
  tag: string;
  fields: ComposedField[];
  lifecycle?: LifecycleDef;
  noOverlap?: EntityDef["noOverlap"];
  /** Optional links dropped because what they point at is not in this build. Formulas read them as empty. */
  absentRefs: string[];
}

export interface ComposedAction extends ActionDef {
  module: string;
  /** Written by the business for its pipeline, not shipped by a module. */
  custom?: boolean;
}

export interface ComposedModule {
  id: string;
  label: string;
  category: ModuleCategory;
  icon: string;
  summary: string;
  entities: string[];
  settings: Record<string, string | number | boolean>;
}

export interface ComposedApp {
  version: 2;
  id: string;
  label: string;
  business: BusinessConfig["business"];
  modules: ComposedModule[];
  entities: ComposedEntity[];
  actions: ComposedAction[];
  /** The entity the board shows. */
  primary: string;
  vocabulary: string[];
  openQuestions: BusinessConfig["openQuestions"];
}

export interface Composition {
  app: ComposedApp | null;
  /** What stops the app being built. Empty means it was. */
  problems: string[];
  /** What the composer changed or assumed on the config's behalf. */
  notes: string[];
  /** The config after normalising — what the app was actually built from. */
  config: BusinessConfig | null;
}

export const humanize = (s: string) => {
  const t = s.replace(/_id$/, "").replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** INV for invoice, IL for invoice_line, POL for purchase_order_line. */
export function tagFor(entity: string): string {
  const parts = entity.split("_");
  return (parts.length === 1 ? entity.slice(0, 3) : parts.map((p) => p[0]).join("")).toUpperCase();
}

const clone = <T>(x: T): T => structuredClone(x);
const isFormula = (v: Value): v is string => typeof v === "string" && v.startsWith("=");

// ------------------------------------------------------------------------- formula names

interface Shape {
  name: string;
  fields: FieldDef[];
  lifecycle?: LifecycleDef;
  absentRefs?: string[];
}

interface Site {
  src: string;
  /** The entity the formula is read on. */
  scope: string;
  where: string;
  params?: FieldDef[];
  settings: Set<string>;
  /**
   * A value an action copies, rather than logic. Copying a field does not make it something
   * a business must keep: an enquiry's budget seeds a work item's value, and a business that
   * drops the budget just gets no value. Logic — formulas, guards, measures — does.
   */
  copy?: boolean;
}

/**
 * Every formula in a set of entities and actions, with what it is read against. Used twice:
 * on the catalogue's own definitions to find which fields the logic depends on, and on the
 * composed app to check that every name still resolves.
 */
function sites(
  entities: Array<Shape & { module: string }>,
  actions: Array<ActionDef & { module: string }>,
  settingsOf: (module: string) => Set<string>,
): Site[] {
  const out: Site[] = [];
  for (const e of entities) {
    const settings = settingsOf(e.module);
    for (const f of e.fields) if (f.formula) out.push({ src: f.formula, scope: e.name, where: `${e.name}.${f.name}'s formula`, settings });
    e.lifecycle?.auto?.forEach((m, i) => out.push({ src: m.if, scope: e.name, where: `${e.name}'s automatic move ${i + 1} (to ${m.to})`, settings }));
  }
  for (const a of actions) {
    const settings = settingsOf(a.module);
    const base = { scope: a.entity, params: a.params ?? [], settings };
    if (a.guard) out.push({ ...base, src: a.guard.if, where: `action ${a.name}'s guard` });
    for (const [m, src] of Object.entries(a.measure ?? {})) if (src) out.push({ ...base, src, where: `action ${a.name}'s ${m} measure` });
    for (const [k, v] of Object.entries(a.sets ?? {})) if (isFormula(v)) out.push({ ...base, src: v.slice(1), where: `action ${a.name}'s value for ${k}`, copy: true });
    for (const [k, v] of Object.entries(a.creates?.fields ?? {})) if (isFormula(v)) out.push({ ...base, src: v.slice(1), where: `action ${a.name}'s value for ${a.creates!.entity}.${k}`, copy: true });
    const ch = a.creates?.children;
    if (ch) {
      const child = { scope: ch.from, params: a.params ?? [], settings };
      if (ch.where) out.push({ ...child, src: ch.where, where: `action ${a.name}'s child filter` });
      for (const [k, v] of Object.entries(ch.fields)) if (isFormula(v)) out.push({ ...child, src: v.slice(1), where: `action ${a.name}'s value for ${ch.to}.${k}`, copy: true });
    }
  }
  return out;
}

/**
 * Resolves every name a formula reads. Calls `touch` for each field it reaches and returns
 * the names that do not resolve. An entity that is not in the build reads as empty — an
 * invoice still adds up its payments when there is no payments module; there are none.
 */
function resolve(site: Site, lookup: (entity: string) => Shape | undefined, touch?: (entity: string, field: string) => void): string[] {
  let refs: Reference[];
  try {
    refs = references(compiled(site.src));
  } catch (e) {
    return [`${site.where}: ${e instanceof Error ? e.message : String(e)}`];
  }
  const problems: string[] = [];

  const path = (p: string[], ent: string, top: boolean) => {
    const e = lookup(ent);
    if (!e) return;
    const [head, ...rest] = p;
    if (top && head === "param") {
      if (!site.params) problems.push(`${site.where}: "param.${rest.join(".")}" — params only exist on an action`);
      else if (rest.length !== 1 || !site.params.some((x) => x.name === rest[0])) {
        problems.push(`${site.where}: no param "${rest.join(".")}" (it has: ${site.params.map((x) => x.name).join(", ") || "none"})`);
      }
      return;
    }
    if (top && head === "setting") {
      if (rest.length !== 1 || !site.settings.has(rest[0])) problems.push(`${site.where}: no setting "${rest.join(".")}"`);
      return;
    }
    if (head === "state" && rest.length === 0) {
      if (!e.lifecycle) problems.push(`${site.where}: ${ent} has no lifecycle, so it has no state`);
      return;
    }
    const f = e.fields.find((x) => x.name === head);
    if (!f) {
      if (!e.absentRefs?.includes(head)) problems.push(`${site.where}: ${ent} has no field "${head}"`);
      return;
    }
    touch?.(ent, head);
    if (!rest.length) return;
    if (f.type !== "ref" || !f.ref) {
      problems.push(`${site.where}: "${head}" is not a link, so "${p.join(".")}" cannot be followed`);
      return;
    }
    path(rest, f.ref, false);
  };

  const visit = (list: Reference[], ent: string) => {
    for (const r of list) {
      if (r.kind === "path") {
        path(r.path, ent, true);
        continue;
      }
      const child = lookup(r.entity);
      if (!child) {
        if (!catalogEntity(r.entity)) problems.push(`${site.where}: there is no entity "${r.entity}"`);
        continue;
      }
      const link = child.fields.find((x) => x.type === "ref" && x.ref === ent);
      if (!link) {
        problems.push(`${site.where}: ${r.entity} has no link to ${ent}, so ${ent} has no ${r.entity} rows to count`);
        continue;
      }
      touch?.(r.entity, link.name);
      if (r.field) path(r.field.split("."), r.entity, false);
      visit(r.inner, r.entity);
    }
  };

  visit(refs, site.scope);
  return problems;
}

// ---------------------------------------------------------------------------- lifecycles

function checkLifecycle(owner: string, lc: LifecycleDef, problems: string[]): void {
  const w = `${owner}'s lifecycle`;
  const order = lc.order;
  const states = new Set(order);
  if (!order.length) problems.push(`${w} has no states`);
  if (states.size !== order.length) problems.push(`${w} names a state twice`);
  for (const s of order) if (!/^[a-z][a-z0-9_]{0,39}$/.test(s)) problems.push(`${w}: state "${s}" is not lowercase snake_case`);
  if (!states.has(lc.initial)) problems.push(`${w}: the initial state "${lc.initial}" is not in its order`);
  for (const s of order) {
    const d = lc.states[s];
    if (!d) {
      problems.push(`${w}: "${s}" is in the order but has no definition`);
      continue;
    }
    for (const n of d.next) if (!states.has(n)) problems.push(`${w}: "${s}" leads to "${n}", which is not a state`);
  }
  for (const s of Object.keys(lc.states)) if (!states.has(s)) problems.push(`${w}: "${s}" is defined but not in the order`);
  for (const s of lc.entry ?? []) if (!states.has(s)) problems.push(`${w}: entry state "${s}" is not a state`);

  const roots = [lc.initial, ...(lc.entry ?? [])].filter((s) => states.has(s));
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of lc.states[cur]?.next ?? []) if (states.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
  }
  for (const s of order) if (!seen.has(s)) problems.push(`${w}: "${s}" cannot be reached from "${lc.initial}"`);
  if (seen.size && ![...seen].some((s) => (lc.states[s]?.next ?? []).length === 0)) {
    problems.push(`${w}: no state ends it — every record would stay open forever`);
  }
  lc.auto?.forEach((m, i) => {
    if (!states.has(m.to)) problems.push(`${w}: automatic move ${i + 1} goes to "${m.to}", which is not a state`);
    for (const f of m.from) {
      if (!states.has(f)) problems.push(`${w}: automatic move ${i + 1} starts from "${f}", which is not a state`);
      else if (f !== m.to && !lc.states[f]?.next.includes(m.to)) problems.push(`${w}: automatic move ${i + 1} goes from "${f}" to "${m.to}", which "${f}" does not lead to`);
    }
  });
}

// ------------------------------------------------------------------------------- compose

/**
 * Keys written one level too deep, moved to where they can only belong.
 *
 * Measured on a live law-firm draft: with its brackets miscounted, the model's pipeline
 * module came out with `lifecycle` inside `entities`, and the whole draft failed on it. No
 * entity in the catalogue is called lifecycle, actions, settings or customActions, and no
 * module has a primary, vocabulary or openQuestions — so where one of those turns up is a
 * slip with exactly one right answer, and it is fixed here rather than sent back to a model.
 */
const MODULE_KEYS = ["lifecycle", "customActions", "actions", "settings"] as const;
const ROOT_KEYS = ["primary", "vocabulary", "openQuestions"] as const;

function hoist(input: unknown, notes: string[]): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const cfg = structuredClone(input) as Record<string, unknown> & { modules?: unknown };
  if (!Array.isArray(cfg.modules)) return cfg;
  for (const m of cfg.modules as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object") continue;
    const id = String(m.id ?? "a module");
    for (const k of ROOT_KEYS) {
      if (k in m && !(k in cfg)) {
        cfg[k] = m[k];
        delete m[k];
        notes.push(`"${k}" was written inside the ${id} module — moved up to the top`);
      }
    }
    const ents = m.entities;
    if (!ents || typeof ents !== "object" || Array.isArray(ents)) continue;
    const e = ents as Record<string, unknown>;
    for (const k of MODULE_KEYS) {
      if (k in e && !(k in m)) {
        m[k] = e[k];
        delete e[k];
        notes.push(`${id}: "${k}" was written inside entities — moved up to the module`);
      }
      for (const [name, ov] of Object.entries(e)) {
        if (ov && typeof ov === "object" && !Array.isArray(ov) && k in ov && !(k in m)) {
          m[k] = (ov as Record<string, unknown>)[k];
          delete (ov as Record<string, unknown>)[k];
          notes.push(`${id}: "${k}" was written inside ${name} — moved up to the module`);
        }
      }
    }
  }
  return cfg;
}

export function compose(input: unknown): Composition {
  const hoisted: string[] = [];
  input = hoist(input, hoisted);
  const parsed = BusinessConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      app: null,
      config: null,
      notes: hoisted,
      problems: parsed.error.issues.slice(0, 25).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const cfg = clone(parsed.data);
  const problems: string[] = [];
  const notes: string[] = [...hoisted];
  // Models repeat themselves; a question asked twice is still one question.
  cfg.openQuestions = cfg.openQuestions.filter((q, i, all) => all.findIndex((x) => x.question.trim().toLowerCase() === q.question.trim().toLowerCase()) === i);

  // ---- which modules
  const chosen = new Map<string, ModuleConfig>();
  for (const mc of cfg.modules) {
    if (!CATALOG.some((m) => m.id === mc.id)) {
      problems.push(`modules: there is no module "${mc.id}" (the catalogue has: ${CATALOG.map((m) => m.id).join(", ")})`);
      continue;
    }
    if (chosen.has(mc.id)) {
      problems.push(`modules: "${mc.id}" is listed twice — put all of its settings in one entry`);
      continue;
    }
    chosen.set(mc.id, mc);
  }
  // A module another one cannot work without is added rather than refused: the answer is not in doubt.
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...chosen.keys()]) {
      for (const r of CATALOG.find((m) => m.id === id)!.requires) {
        if (chosen.has(r)) continue;
        chosen.set(r, { id: r, entities: {}, actions: {}, settings: {}, customActions: [] });
        notes.push(`added the ${r} module — ${id} needs it`);
        grew = true;
      }
    }
  }
  const modules: ModuleDef[] = CATALOG.filter((m) => chosen.has(m.id));
  const present = new Set(modules.flatMap((m) => m.entities.map((e) => e.name)));
  cfg.modules = modules.map((m) => chosen.get(m.id)!);

  // ---- what the logic reads, so a business cannot drop it
  const settingsOf = (id: string) => new Set((CATALOG.find((m) => m.id === id)?.settings ?? []).map((s) => s.name));
  const guarded = new Map<string, Set<string>>();
  const guard = (entity: string, field: string) => {
    if (!guarded.has(entity)) guarded.set(entity, new Set());
    guarded.get(entity)!.add(field);
  };
  const catalogShapes = modules.flatMap((m) => m.entities.map((e) => ({ ...e, module: m.id })));
  const catalogLookup = (name: string) => (present.has(name) ? catalogEntity(name) : undefined);
  for (const s of sites(catalogShapes, modules.flatMap((m) => m.actions.map((a) => ({ ...a, module: m.id }))), settingsOf)) {
    if (!s.copy) resolve(s, catalogLookup, guard);
  }
  for (const e of catalogShapes) {
    guard(e.name, e.title);
    if (e.noOverlap) for (const f of [e.noOverlap.resource, e.noOverlap.start, e.noOverlap.end]) guard(e.name, f);
  }

  // ---- entities
  const entities: ComposedEntity[] = [];
  for (const m of modules) {
    const mc = chosen.get(m.id)!;
    for (const key of Object.keys(mc.entities)) {
      if (!m.entities.some((e) => e.name === key)) {
        problems.push(`modules.${m.id}.entities: ${m.id} has no entity "${key}" (it has: ${m.entities.map((e) => e.name).join(", ")})`);
      }
    }
    if (mc.lifecycle && m.extensible === undefined) problems.push(`modules.${m.id}: only the pipeline takes its own lifecycle`);

    for (const def of m.entities) {
      const ov = mc.entities[def.name] ?? { relabel: {}, drop: [], add: [], options: {}, states: {} };
      let fields: FieldDef[] = clone(def.fields);
      const absentRefs: string[] = [];

      fields = fields.filter((f) => {
        if (f.type !== "ref" || !f.ref || present.has(f.ref)) return true;
        if (f.required) problems.push(`${def.name}.${f.name} needs ${f.ref}, which is not in this build`);
        absentRefs.push(f.name);
        return false;
      });

      for (const d of ov.drop) {
        const f = fields.find((x) => x.name === d);
        if (!f) {
          if (!absentRefs.includes(d)) notes.push(`${def.name}: ignored dropping "${d}", which it does not have`);
          continue;
        }
        if (f.core || f.required || guarded.get(def.name)?.has(d)) {
          notes.push(`${def.name}: kept "${d}" — the ${m.id} module's own logic reads it`);
          continue;
        }
        fields = fields.filter((x) => x.name !== d);
      }
      for (const [k, label] of Object.entries(ov.relabel)) {
        const f = fields.find((x) => x.name === k);
        if (f) f.label = label;
        // A link to a module this build does not have was dropped above; naming it is harmless, not a slip.
        else if (!absentRefs.includes(k)) notes.push(`${def.name}: ignored relabelling "${k}", which it does not have`);
      }
      for (const [k, options] of Object.entries(ov.options)) {
        const f = fields.find((x) => x.name === k);
        if (f?.type === "choice") f.options = [...new Set(options)];
        else notes.push(`${def.name}: ignored options for "${k}", which is not a choice field`);
      }
      const composedFields: ComposedField[] = fields.map((f) => ({ ...f, label: f.label ?? humanize(f.name), storage: storageOf(f.type) }));
      for (const a of ov.add) {
        if (a.name === "id" || composedFields.some((x) => x.name === a.name) || absentRefs.includes(a.name)) {
          notes.push(`${def.name}: did not add "${a.name}" — it already has a field by that name`);
          continue;
        }
        composedFields.push({ ...a, label: a.label ?? humanize(a.name), storage: storageOf(a.type), added: true });
      }

      let lifecycle = def.lifecycle ? clone(def.lifecycle) : undefined;
      if (m.extensible === def.name && mc.lifecycle) {
        lifecycle = {
          order: mc.lifecycle.order,
          initial: mc.lifecycle.initial,
          states: Object.fromEntries(Object.entries(mc.lifecycle.states).map(([s, d]) => [s, { label: d.label, requirements: d.requirements, next: d.next }])),
        };
      }
      for (const [s, label] of Object.entries(ov.states)) {
        if (lifecycle?.states[s]) lifecycle.states[s].label = label;
        else notes.push(`${def.name}: ignored relabelling state "${s}", which it does not have`);
      }

      entities.push({
        name: def.name,
        module: m.id,
        label: ov.label ?? def.label,
        singular: ov.singular ?? def.singular,
        purpose: ov.purpose ?? def.purpose,
        title: def.title,
        key: "id",
        tag: tagFor(def.name),
        fields: composedFields,
        ...(lifecycle ? { lifecycle } : {}),
        ...(def.noOverlap ? { noOverlap: clone(def.noOverlap) } : {}),
        absentRefs,
      });
    }
  }
  const byName = new Map(entities.map((e) => [e.name, e]));

  // ---- actions
  const catalogActionNames = new Set(CATALOG.flatMap((m) => m.actions.map((a) => a.name)));
  const actions: ComposedAction[] = [];
  const fieldOf = (entity: string, field: string) => byName.get(entity)?.fields.find((f) => f.name === field);
  const dropped = (entity: string, field: string) => !fieldOf(entity, field) && !byName.get(entity)?.absentRefs.includes(field);

  for (const m of modules) {
    const mc = chosen.get(m.id)!;
    for (const key of Object.keys(mc.actions)) {
      if (!m.actions.some((a) => a.name === key) && !mc.customActions.some((a) => a.name === key)) {
        problems.push(`modules.${m.id}.actions: ${m.id} has no action "${key}" (it has: ${m.actions.map((a) => a.name).join(", ")})`);
      }
    }
    for (const def of m.actions) {
      const ov = mc.actions[def.name];
      if (ov?.enabled === false) continue;
      if (!present.has(def.entity)) continue;
      const a: ComposedAction = { ...clone(def), module: m.id };
      if (ov?.label) a.label = ov.label;
      if (ov?.policy) a.policy = ov.policy;

      if (a.creates && !present.has(a.creates.entity)) {
        const owner = CATALOG.find((x) => x.entities.some((e) => e.name === a.creates!.entity));
        notes.push(`"${a.name}" is not offered — it makes a ${a.creates.entity}, and the ${owner?.id ?? a.creates.entity} module is not in this build`);
        continue;
      }
      if (a.creates?.children && (!present.has(a.creates.children.from) || !present.has(a.creates.children.to))) {
        delete a.creates.children;
      }
      // A value written to a field the business dropped is a value nobody will read.
      for (const k of Object.keys(a.sets ?? {})) {
        if (dropped(a.entity, k)) {
          delete a.sets![k];
          notes.push(`"${a.name}" no longer records ${k} — the field was dropped`);
        }
      }
      if (a.creates) {
        for (const k of Object.keys(a.creates.fields)) if (!fieldOf(a.creates.entity, k)) delete a.creates.fields[k];
        const ch = a.creates.children;
        if (ch) for (const k of Object.keys(ch.fields)) if (!fieldOf(ch.to, k)) delete ch.fields[k];
      }
      // And a value copied from a field the business dropped has nothing to copy.
      const settings = settingsOf(m.id);
      const reads = (src: string, scope: string) =>
        resolve({ src, scope, where: "", params: a.params ?? [], settings }, (n) => byName.get(n)).length === 0;
      for (const [k, v] of Object.entries(a.sets ?? {})) {
        if (isFormula(v) && !reads(v.slice(1), a.entity)) {
          delete a.sets![k];
          notes.push(`"${a.name}" no longer fills ${k} — what it copied from was dropped`);
        }
      }
      for (const [k, v] of Object.entries(a.creates?.fields ?? {})) {
        if (isFormula(v) && !reads(v.slice(1), a.entity)) {
          delete a.creates!.fields[k];
          notes.push(`"${a.name}" no longer fills ${a.creates!.entity}.${k} — what it copied from was dropped`);
        }
      }
      actions.push(a);
    }

    if (mc.customActions.length && !m.extensible) problems.push(`modules.${m.id}: only the pipeline takes its own actions`);
    if (!m.extensible) continue;
    for (const c of mc.customActions) {
      if (catalogActionNames.has(c.name)) {
        problems.push(`modules.${m.id}.customActions: "${c.name}" is already an action of another module — use that module, or pick another name`);
        continue;
      }
      const a: ComposedAction = { ...clone(c), entity: m.extensible, module: m.id, custom: true } as ComposedAction;
      const ov = mc.actions[c.name];
      if (ov?.enabled === false) continue;
      if (ov?.label) a.label = ov.label;
      if (ov?.policy) a.policy = ov.policy;
      if (!a.params?.length) delete a.params;
      // A threshold needs a figure to compare. When the model gave none, it gets a param of
      // the obvious name — the person taking the action types the amount.
      if (a.policy.mode === "threshold" && !a.measure?.[a.policy.measure]) {
        const pname = a.policy.measure === "amount" ? "amount" : "discount_pct";
        const ptype = a.policy.measure === "amount" ? "money" : "percent";
        a.params = a.params ?? [];
        if (!a.params.some((p) => p.name === pname)) a.params.push({ name: pname, type: ptype, required: true });
        a.measure = { ...(a.measure ?? {}), [a.policy.measure]: `param.${pname}` };
        notes.push(`"${a.name}" compares param.${pname} against its ${a.policy.measure} threshold`);
      }
      // A move with no "when" is legal from wherever leads there.
      const lc = byName.get(m.extensible)?.lifecycle;
      if (a.to && !a.when && lc) {
        a.when = lc.order.filter((s) => lc.states[s]?.next.includes(a.to!));
        notes.push(`"${a.name}" is offered where its move is legal: ${a.when.join(", ") || "nowhere"}`);
      }
      actions.push(a);
    }
  }

  // ---- primary
  let primary = cfg.primary;
  if (!primary) {
    // In the order the business listed its modules — what it named first is what its day is about.
    primary = present.has("work_item")
      ? "work_item"
      : [...chosen.keys()].flatMap((id) => CATALOG.find((m) => m.id === id)!.entities).find((e) => e.lifecycle)?.name;
    if (primary) notes.push(`the board shows ${primary} — no primary was given`);
  }
  if (!primary) problems.push("primary: nothing in this build has stages to put on a board — add the pipeline");
  else if (!byName.get(primary)) problems.push(`primary: "${primary}" is not an entity in this build`);
  else if (!byName.get(primary)!.lifecycle) problems.push(`primary: "${primary}" has no stages, so it cannot be the board`);

  // ---- settings
  const composedModules: ComposedModule[] = modules.map((m) => {
    const mc = chosen.get(m.id)!;
    const settings: Record<string, string | number | boolean> = {};
    for (const s of m.settings) {
      const given = mc.settings[s.name];
      let v = given ?? s.default;
      if (given !== undefined) {
        if ((s.type === "integer" || s.type === "number" || s.type === "money" || s.type === "percent") && typeof v !== "number") {
          const n = Number(v);
          if (Number.isFinite(n)) v = n;
          else problems.push(`modules.${m.id}.settings.${s.name}: must be a number`);
        }
        if (s.type === "integer" && typeof v === "number" && !Number.isInteger(v)) problems.push(`modules.${m.id}.settings.${s.name}: must be a whole number`);
        if (s.type === "boolean" && typeof v !== "boolean") problems.push(`modules.${m.id}.settings.${s.name}: must be true or false`);
        if (s.type === "choice" && !s.options?.includes(String(v))) problems.push(`modules.${m.id}.settings.${s.name}: must be one of ${s.options?.join(", ")}`);
      }
      settings[s.name] = v;
    }
    for (const k of Object.keys(mc.settings)) if (!m.settings.some((s) => s.name === k)) notes.push(`${m.id}: ignored setting "${k}", which it does not have`);
    return {
      id: m.id,
      label: mc.label ?? m.label,
      category: m.category,
      icon: m.icon,
      summary: m.summary,
      entities: m.entities.map((e) => e.name),
      settings,
    };
  });

  const app: ComposedApp = {
    version: 2,
    id: cfg.id,
    label: cfg.label,
    business: cfg.business,
    modules: composedModules,
    entities,
    actions,
    primary: primary ?? "",
    vocabulary: cfg.vocabulary,
    openQuestions: cfg.openQuestions,
  };
  problems.push(...validate(app));
  return { app: problems.length ? null : app, problems, notes, config: cfg };
}

// ------------------------------------------------------------------------------ validate

/** Everything wrong with a composed app. Run on every composition, and on the whole catalogue by the tests. */
export function validate(app: ComposedApp): string[] {
  const problems: string[] = [];
  const byName = new Map(app.entities.map((e) => [e.name, e]));
  const settingsOf = (id: string) => new Set(Object.keys(app.modules.find((m) => m.id === id)?.settings ?? {}));
  const ident = /^[a-z][a-z0-9_]{0,39}$/;

  for (const e of app.entities) {
    const names = new Set<string>();
    for (const f of e.fields) {
      if (!ident.test(f.name)) problems.push(`${e.name}.${f.name}: not lowercase snake_case`);
      if (names.has(f.name)) problems.push(`${e.name}: field "${f.name}" appears twice`);
      names.add(f.name);
      if (f.type === "choice" && !f.options?.length) problems.push(`${e.name}.${f.name}: a choice field needs options`);
      if (f.type === "ref" && (!f.ref || !byName.has(f.ref))) problems.push(`${e.name}.${f.name}: links to "${f.ref}", which is not in this build`);
      if (f.formula && f.required) problems.push(`${e.name}.${f.name}: a computed field cannot also be required`);
    }
    if (!names.has(e.title)) problems.push(`${e.name}: its title field "${e.title}" is missing`);
    if (e.lifecycle) checkLifecycle(e.name, e.lifecycle, problems);
    if (e.noOverlap) {
      for (const f of [e.noOverlap.resource, e.noOverlap.start, e.noOverlap.end]) if (!names.has(f)) problems.push(`${e.name}: no-overlap rule reads "${f}", which is missing`);
      for (const s of e.noOverlap.except) if (!e.lifecycle?.order.includes(s)) problems.push(`${e.name}: no-overlap rule names state "${s}", which it does not have`);
    }
  }

  const seen = new Set<string>();
  for (const a of app.actions) {
    const w = `action ${a.name}`;
    if (!ident.test(a.name)) problems.push(`${w}: not lowercase snake_case`);
    if (seen.has(a.name)) problems.push(`${w}: two actions have this name`);
    seen.add(a.name);
    const e = byName.get(a.entity);
    if (!e) {
      problems.push(`${w}: acts on "${a.entity}", which is not in this build`);
      continue;
    }
    const lc = e.lifecycle;
    if ((a.when || a.to) && !lc) problems.push(`${w}: ${a.entity} has no stages, so the action cannot name any`);
    if (lc) {
      for (const s of a.when ?? []) if (!lc.order.includes(s)) problems.push(`${w}: legal in "${s}", which ${a.entity} does not have`);
      if (a.to) {
        if (!lc.order.includes(a.to)) problems.push(`${w}: moves to "${a.to}", which ${a.entity} does not have`);
        else {
          const from = (a.when ?? lc.order).filter((s) => s !== a.to && lc.states[s]);
          const stuck = from.filter((s) => !lc.states[s].next.includes(a.to!));
          if (stuck.length) problems.push(`${w}: moves to "${a.to}" but is offered in ${stuck.join(", ")}, which do${stuck.length === 1 ? "es" : ""} not lead there`);
        }
      }
    }
    const pnames = new Set<string>();
    for (const p of a.params ?? []) {
      if (!ident.test(p.name)) problems.push(`${w}: param "${p.name}" is not lowercase snake_case`);
      if (pnames.has(p.name)) problems.push(`${w}: param "${p.name}" appears twice`);
      pnames.add(p.name);
      if (p.type === "choice" && !p.options?.length) problems.push(`${w}: param "${p.name}" is a choice with no options`);
      if (p.type === "ref" && (!p.ref || !byName.has(p.ref))) problems.push(`${w}: param "${p.name}" links to "${p.ref}", which is not in this build`);
    }
    if (a.policy.mode === "threshold" && !a.measure?.[a.policy.measure]) {
      problems.push(`${w}: a ${a.policy.measure} threshold needs measure.${a.policy.measure} — the figure to compare`);
    }
    for (const k of Object.keys(a.sets ?? {})) {
      const f = e.fields.find((x) => x.name === k);
      if (!f) problems.push(`${w}: writes "${k}", which ${a.entity} does not have`);
      else if (f.formula) problems.push(`${w}: writes "${k}", which is computed`);
    }
    const c = a.creates;
    if (c) {
      const t = byName.get(c.entity);
      if (!t) problems.push(`${w}: makes a ${c.entity}, which is not in this build`);
      else {
        for (const k of Object.keys(c.fields)) {
          const f = t.fields.find((x) => x.name === k);
          if (!f) problems.push(`${w}: fills ${c.entity}.${k}, which does not exist`);
          else if (f.formula) problems.push(`${w}: fills ${c.entity}.${k}, which is computed`);
        }
        const missing = t.fields.filter((f) => f.required && !f.formula && !(f.name in c.fields));
        if (missing.length) problems.push(`${w}: makes a ${c.entity} without its required ${missing.map((f) => f.name).join(", ")}`);
        if (c.state && !t.lifecycle?.order.includes(c.state)) problems.push(`${w}: makes a ${c.entity} in state "${c.state}", which it does not have`);
        const ch = c.children;
        if (ch) {
          const from = byName.get(ch.from);
          const to = byName.get(ch.to);
          const backLink = to?.fields.find((f) => f.type === "ref" && f.ref === c.entity);
          if (!from?.fields.some((f) => f.type === "ref" && f.ref === a.entity)) problems.push(`${w}: copies ${ch.from} rows, which have no link to ${a.entity}`);
          if (!to || !backLink) problems.push(`${w}: copies into ${ch.to}, which has no link to ${c.entity}`);
          else {
            for (const k of Object.keys(ch.fields)) if (!to.fields.some((f) => f.name === k && !f.formula)) problems.push(`${w}: fills ${ch.to}.${k}, which does not exist or is computed`);
            const need = to.fields.filter((f) => f.required && !f.formula && f.name !== backLink.name && !(f.name in ch.fields));
            if (need.length) problems.push(`${w}: copies into ${ch.to} without its required ${need.map((f) => f.name).join(", ")}`);
          }
        }
      }
    }
  }

  const lookup = (n: string): Shape | undefined => byName.get(n);
  for (const s of sites(app.entities, app.actions, settingsOf)) problems.push(...resolve(s, lookup));

  const p = byName.get(app.primary);
  if (app.primary && !p) problems.push(`primary: "${app.primary}" is not an entity in this build`);
  return [...new Set(problems)];
}

// ------------------------------------------------------------------------------- helpers

/** Every module in the catalogue, unconfigured — the composition the tests hold the catalogue to. */
export function everything(): BusinessConfig {
  return {
    id: "everything",
    label: "Every module",
    business: { name: "Catalogue check", currency: "INR", currencySymbol: "₹", locale: "en-IN", timezone: "Asia/Kolkata" },
    modules: CATALOG.map((m) => ({ id: m.id, entities: {}, actions: {}, settings: {}, customActions: [] })),
    primary: "work_item",
    vocabulary: [],
    openQuestions: [],
  };
}
