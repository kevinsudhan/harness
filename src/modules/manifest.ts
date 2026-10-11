/**
 * A composition, as the app runtime reads it — and each entity's state machine, as the
 * kernel reads it.
 *
 * The kernel (domain/machine.ts, domain/policy.ts) takes a VerticalConfig: states, which
 * actions each state allows, which actions always need a person and above what number.
 * A composed app has one of those per entity with stages — an invoice's machine, a
 * membership's, the clinic's own treatment course — built here from the modules' actions.
 * The kernel is not changed and does not learn it is running an invoice: the same `can()`
 * and the same `decideFor()` that run the freight desk run every one of them.
 */
import type { AppAction, AppColumn, AppEntity, AppManifest, Role } from "../builder/appManifest.js";
import type { VerticalConfig, ThresholdRule } from "../verticals/types.js";
import type { ComposedApp, ComposedEntity } from "./compose.js";

/** Which of the existing shell's page roles an entity plays — for its icon and its sample-data order. */
const ROLE: Record<string, Role> = {
  quote_line: "lines",
  invoice_line: "lines",
  purchase_order_line: "lines",
  session: "slots",
  resource: "slots",
  reservation: "bookings",
  appointment: "bookings",
  supplier: "partners",
  quote: "quotes",
  call: "calls",
  message: "events",
};

export function machineFor(
  entity: Pick<ComposedEntity, "name" | "label" | "lifecycle">,
  actions: AppAction[],
  business: VerticalConfig["business"],
): VerticalConfig {
  const own = actions.filter((a) => a.entity === entity.name);
  const lc = entity.lifecycle ?? { order: [], initial: "", states: {} };
  const alwaysApprove: VerticalConfig["policy"]["alwaysApprove"] = {};
  const thresholds: ThresholdRule<string>[] = [];
  for (const a of own) {
    if (a.policy.mode === "approve") alwaysApprove[a.name] = { why: a.policy.why, approver: a.policy.approver };
    if (a.policy.mode === "threshold") {
      thresholds.push({ actions: [a.name], measure: a.policy.measure, limit: a.policy.limit, trigger: a.policy.trigger, approver: a.policy.approver });
    }
  }
  return {
    id: entity.name,
    label: entity.label,
    business,
    lifecycle: {
      order: lc.order,
      initial: lc.initial,
      states: Object.fromEntries(
        lc.order.map((s) => [
          s,
          {
            label: lc.states[s]?.label ?? s,
            requirements: lc.states[s]?.requirements ?? [],
            actions: own.filter((a) => !a.when || a.when.includes(s)).map((a) => a.name),
            next: lc.states[s]?.next ?? [],
          },
        ]),
      ),
    },
    actions: own.map((a) => a.name),
    policy: { alwaysApprove, thresholds },
    builder: { vocabulary: [], entityAliases: {}, capabilityModules: [] },
  };
}

export function toAppManifest(app: ComposedApp): AppManifest {
  const actions: AppAction[] = app.actions;
  const entities: AppEntity[] = app.entities.map((e) => {
    const columns: AppColumn[] = [
      { name: "id", type: "text", pk: true, label: "Ref" },
      ...e.fields.map((f) => ({
        name: f.name,
        type: f.storage,
        label: f.label,
        semantic: f.type,
        ...(f.type === "ref" && f.ref ? { links: f.ref } : {}),
        ...(f.options ? { options: f.options } : {}),
        ...(f.required ? { required: true } : {}),
        ...(f.formula ? { formula: f.formula } : {}),
        ...(f.pii ? { pii: true } : {}),
        ...(f.help ? { help: f.help } : {}),
      })),
      ...(e.lifecycle ? [{ name: "stage", type: "text", label: "Stage", semantic: "text" as const }] : []),
      { name: "created_at", type: "timestamp with time zone", label: "Created", semantic: "datetime" },
      { name: "updated_at", type: "timestamp with time zone", label: "Updated", semantic: "datetime" },
    ];
    return {
      name: e.name,
      label: e.label,
      singular: e.singular,
      purpose: e.purpose,
      from: null,
      role: e.name === app.primary ? "primary" : ROLE[e.name] ?? "other",
      key: "id",
      title: e.title,
      columns,
      module: e.module,
      tag: e.tag,
      ...(e.lifecycle ? { lifecycle: e.lifecycle, stageColumn: "stage" } : {}),
      ...(e.noOverlap ? { noOverlap: e.noOverlap } : {}),
    };
  });

  const primary = app.entities.find((e) => e.name === app.primary)!;
  // The shell's board, timeline and setup pages read `vertical`: the primary entity's machine,
  // named for the business so references read DEN-…, MMA-….
  const vertical = { ...machineFor(primary, actions, app.business), id: app.id, label: app.label };

  return {
    version: 2,
    business: app.business,
    vertical,
    modules: app.modules,
    actions,
    primary: { entity: app.primary, stageColumn: "stage" },
    entities,
    agents: [],
    workflows: [],
    memory: { dataset: `${app.id}_memory`, domains: app.vocabulary },
    openQuestions: app.openQuestions,
    template: "module catalogue",
  };
}
