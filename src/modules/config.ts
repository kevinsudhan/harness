/**
 * What a model writes to configure a business — and all it can write.
 *
 * The old fork spec let a model rename columns of freight tables, which is a large surface
 * with many ways to be wrong and few to be checked. This one is deliberately narrow. A
 * model picks modules from the catalogue and, for each, may:
 *
 *   - relabel things in the business's own words (Patients, Bills, Trial class),
 *   - drop optional fields and add fields of its own,
 *   - replace a choice field's options,
 *   - turn actions off, rename them, and change who approves them and above what amount,
 *   - set the module's settings (payment terms, reminder hours),
 *
 * and, for the pipeline only, write the business's own stages and actions. It cannot
 * rename a table or a field, so nothing the engine or another module depends on can move.
 *
 * The same file is what a person edits to change a business later: it is short, it is
 * the whole configuration, and composing it again is free.
 */
import { z } from "zod";
import { FIELD_TYPES, EFFECTS, type FieldType, type Effect } from "./types.js";

export const Ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase snake_case, starting with a letter, at most 40 chars");

const Approver = z.enum(["desk", "compliance", "finance"]);

export const PolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("approve"), approver: Approver, why: z.string().min(1) }),
  z.object({
    mode: z.literal("threshold"),
    measure: z.enum(["amount", "discountPct"]),
    limit: z.number().nonnegative(),
    trigger: z.enum(["atOrAbove", "above"]),
    approver: Approver,
  }),
]);

export const FieldSchema = z.object({
  name: Ident,
  type: z.enum(FIELD_TYPES as unknown as [FieldType, ...FieldType[]]),
  label: z.string().optional(),
  help: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1)).optional(),
  ref: Ident.optional(),
  pii: z.boolean().optional(),
  formula: z.string().optional(),
});

const ValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const EntityOverlaySchema = z.object({
  label: z.string().min(1).optional(),
  singular: z.string().min(1).optional(),
  purpose: z.string().optional(),
  /** field → the business's word for it */
  relabel: z.record(z.string(), z.string().min(1)).default({}),
  /** optional fields the business does not need */
  drop: z.array(z.string()).default([]),
  /** fields the business needs that the module does not have */
  add: z.array(FieldSchema).default([]),
  /** choice field → its options for this business */
  options: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
  /** state → the business's word for it */
  states: z.record(z.string(), z.string().min(1)).default({}),
});

const ActionOverlaySchema = z.object({
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  policy: PolicySchema.optional(),
});

const StateSchema = z.object({
  label: z.string().min(1),
  requirements: z.array(z.string()).default([]),
  next: z.array(Ident).default([]),
});

export const CustomActionSchema = z.object({
  name: Ident,
  label: z.string().min(1),
  summary: z.string().min(1),
  effects: z.array(z.enum(EFFECTS as unknown as [Effect, ...Effect[]])).min(1),
  policy: PolicySchema,
  when: z.array(Ident).optional(),
  to: Ident.optional(),
  params: z.array(FieldSchema).default([]),
  measure: z.object({ amount: z.string().optional(), discountPct: z.string().optional() }).optional(),
  guard: z.object({ if: z.string(), else: z.string() }).optional(),
  sets: z.record(z.string(), ValueSchema).optional(),
  creates: z.object({
    entity: Ident,
    fields: z.record(z.string(), ValueSchema),
    state: Ident.optional(),
  }).optional(),
});

export const ModuleConfigSchema = z.object({
  id: Ident,
  /** The module's name in the navigation, in the business's words. */
  label: z.string().min(1).optional(),
  entities: z.record(z.string(), EntityOverlaySchema).default({}),
  actions: z.record(z.string(), ActionOverlaySchema).default({}),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** The pipeline only: the business's own stages. */
  lifecycle: z.object({
    order: z.array(Ident).min(2).max(12),
    initial: Ident,
    states: z.record(z.string(), StateSchema),
  }).optional(),
  /** The pipeline only: the business's own actions on its work. */
  customActions: z.array(CustomActionSchema).max(24).default([]),
});

export const BusinessConfigSchema = z.object({
  id: Ident,
  /** What kind of business, in a few words — "Dental clinic", "MMA gym". */
  label: z.string().min(1),
  business: z.object({
    name: z.string().min(1).max(60),
    currency: z.string().length(3),
    currencySymbol: z.string().min(1).max(4),
    locale: z.string().min(2),
    timezone: z.string().min(3),
  }),
  modules: z.array(ModuleConfigSchema).min(1).max(30),
  /** The entity the board shows — whatever the business's day revolves around. */
  primary: Ident.optional(),
  vocabulary: z.array(z.string()).default([]),
  openQuestions: z.array(z.object({ question: z.string(), blocks: z.enum(["structure", "behaviour"]) })).default([]),
});

export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;
export type ModuleConfig = z.infer<typeof ModuleConfigSchema>;
export type CustomAction = z.infer<typeof CustomActionSchema>;
