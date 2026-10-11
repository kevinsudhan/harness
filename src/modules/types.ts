/**
 * The module contract — what one piece of business software is, written as data.
 *
 * The old builder cloned the freight CRM's tables and asked a model to rename their
 * columns, which is why it needed a list of cargo measurements it must never relabel and a
 * "leftover" flag to hide container geometry from a dental desk. A module turns that
 * around. Invoicing, scheduling, memberships and the rest are each written once, generic
 * from the start, with names that never change: an invoice is `invoice`, its total is
 * `total`, issuing it is `issue_invoice`. A business does not rename them; it relabels
 * them ("Bills", "Amount due") and the identifiers underneath stay put.
 *
 * Keeping the identifiers fixed is what makes the rest possible:
 *   - the engine can depend on a field (`balance_due`) without a model having to keep it;
 *   - an action is the same tool name in every business, so an agent's tools and the
 *     policy that governs them are stable;
 *   - a model configuring a business edits labels, options, extra fields and approval
 *     rules — a small surface it can get right — instead of designing tables.
 *
 * Everything here is plain data. Behaviour comes from four declarative pieces the engine
 * interprets: a lifecycle (the kernel's state machine), actions (what may be done, where,
 * and what it changes), formulas (computed fields and conditions, see formula.ts), and
 * policy defaults (the kernel's approval gate). No module carries code.
 */
import type { Approver } from "../verticals/types.js";

export type { Approver };

/**
 * What a field holds, in the business's terms rather than SQL's. The composer maps each
 * to a storage type; the UI and the model read these.
 */
export type FieldType =
  | "text" | "longtext" | "integer" | "number" | "money" | "percent" | "boolean"
  | "date" | "datetime" | "email" | "phone" | "url" | "choice" | "tags" | "ref" | "json";

export const FIELD_TYPES: readonly FieldType[] = [
  "text", "longtext", "integer", "number", "money", "percent", "boolean",
  "date", "datetime", "email", "phone", "url", "choice", "tags", "ref", "json",
];

export interface FieldDef {
  name: string;
  type: FieldType;
  label?: string;
  /** One line on what the field means. Shown in forms and to the model. */
  help?: string;
  required?: boolean;
  /** The allowed values of a `choice` field. A business may replace them. */
  options?: string[];
  /** The entity a `ref` field points at. When that entity is not in a build, an optional ref is dropped. */
  ref?: string;
  /** Personal data. Drives consent, export and erasure, and what an agent may read. */
  pii?: boolean;
  /** The module's own logic depends on this field: a business may relabel it, never drop it. */
  core?: boolean;
  /** Computed by the engine from other fields; never typed in. See formula.ts. */
  formula?: string;
}

export interface StateDef {
  label: string;
  /** What must be true before a record may leave this state — the kernel's requirements. */
  requirements?: string[];
  /** States reachable from here. Empty means terminal. */
  next: string[];
}

/** A move the engine makes on its own once a condition holds, e.g. an invoice whose balance reaches zero. */
export interface AutoMove {
  from: string[];
  to: string;
  if: string;
}

export interface LifecycleDef {
  order: string[];
  initial: string;
  states: Record<string, StateDef>;
  /** Other states a row may be created in — an inbound message arrives "received", never "draft". */
  entry?: string[];
  auto?: AutoMove[];
}

export interface EntityDef {
  /** Stable and unique across the whole catalogue. */
  name: string;
  label: string;
  singular: string;
  purpose: string;
  /** The field that names a row in one line. */
  title: string;
  fields: FieldDef[];
  lifecycle?: LifecycleDef;
  /** Rows on the same resource may not overlap in time — a chair, a room, a vet. */
  noOverlap?: { resource: string; start: string; end: string; except: string[] };
}

/**
 * What an action touches, which is what a reviewer and a policy care about:
 *   record       changes the business's own records only
 *   outbound     reaches someone outside the business (a message, a document, a link)
 *   money        moves or commits money
 *   sensitive    exposes personal, clinical or legal data
 *   destructive  hard to undo — cancels, voids, erases
 */
export type Effect = "record" | "outbound" | "money" | "sensitive" | "destructive";
export const EFFECTS: readonly Effect[] = ["record", "outbound", "money", "sensitive", "destructive"];

/** The default answer to "may this happen without a person?" — the kernel's two policy kinds plus "yes". */
export type PolicyDefault =
  | { mode: "auto" }
  | { mode: "approve"; approver: Approver; why: string }
  | { mode: "threshold"; measure: "amount" | "discountPct"; limit: number; trigger: "atOrAbove" | "above"; approver: Approver };

/**
 * A value an action writes. A string starting with "=" is a formula (formula.ts), evaluated
 * against the record the action is taken on, its params (`param.x`) and the module's
 * settings (`setting.x`). Anything else is written as it is.
 */
export type Value = string | number | boolean | null;

export interface CreateDef {
  /** The entity a new row is made in. When it is not in a build, the action is not offered. */
  entity: string;
  fields: Record<string, Value>;
  /** The state the new row starts in, when not its lifecycle's initial state. */
  state?: string;
  /**
   * Copy the acting record's child rows across — a quote's lines into the invoice it
   * becomes. In `fields`, names refer to the child row; the link to the new parent is set.
   */
  children?: { from: string; to: string; fields: Record<string, Value>; where?: string };
}

export interface ActionDef {
  /** Stable and unique across the catalogue: it is the tool name an agent calls. */
  name: string;
  label: string;
  /** The entity the action is taken on. May belong to another module (payments act on an invoice). */
  entity: string;
  /** What it does, in one sentence. Becomes the tool's description. */
  summary: string;
  effects: Effect[];
  policy: PolicyDefault;
  /** Inputs beyond the record itself. */
  params?: FieldDef[];
  /** The states it is legal in. Omitted means every state. Only for entities with a lifecycle. */
  when?: string[];
  /** The state it moves the record to, through the kernel's gate. */
  to?: string;
  /** Refused, with `else` as the reason, unless the formula holds. */
  guard?: { if: string; else: string };
  /** Fields of the record written when the action is performed. */
  sets?: Record<string, Value>;
  creates?: CreateDef;
  /** Which figures the policy gate compares, as formulas — `total`, `param.amount`. */
  measure?: { amount?: string; discountPct?: string };
}

export interface SettingDef {
  name: string;
  label: string;
  type: "integer" | "number" | "money" | "percent" | "text" | "boolean" | "choice";
  default: string | number | boolean;
  options?: string[];
  help: string;
}

export type ModuleCategory = "core" | "sales" | "finance" | "operations" | "people" | "engagement" | "control";

export interface ModuleDef {
  id: string;
  label: string;
  category: ModuleCategory;
  /** What the module gives a business, in one line. The model chooses modules from this. */
  summary: string;
  /** Example businesses that use it. For the model and for people reading the catalogue. */
  usedBy: string[];
  /** Modules this one cannot work without — its required refs point into them. */
  requires: string[];
  entities: EntityDef[];
  actions: ActionDef[];
  settings: SettingDef[];
  /**
   * The one entity a business may give its own lifecycle and its own actions. Only the
   * pipeline has one: a dental course of treatment and a court matter have nothing in
   * common but the fact that they move through stages, so those stages cannot be shipped.
   */
  extensible?: string;
  /** A lucide icon name for the navigation. */
  icon: string;
}

export function defineModule(m: ModuleDef): ModuleDef {
  return m;
}

// Shorthands for the catalogue files, so a policy reads as one line.
export const AUTO: PolicyDefault = { mode: "auto" };
export const approve = (approver: Approver, why: string): PolicyDefault => ({ mode: "approve", approver, why });
export const amountAtOrAbove = (limit: number, approver: Approver): PolicyDefault =>
  ({ mode: "threshold", measure: "amount", limit, trigger: "atOrAbove", approver });
export const discountAbove = (limit: number, approver: Approver): PolicyDefault =>
  ({ mode: "threshold", measure: "discountPct", limit, trigger: "above", approver });
