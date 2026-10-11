/**
 * A composed business's tools — what an agent may call, derived from app.json.
 *
 * One list, read by three things that must never disagree about it: the MCP server that
 * serves the tools, the agent that plans with them, and the ArmorIQ policy that says which
 * of them the agent may use. Generated, never written: a business composed with the
 * invoicing module has `issue_invoice`, one without it does not, and nothing has to be
 * kept in step by hand.
 *
 *   find_records, get_record   read — what is there, and what can be done to it now
 *   create_<entity>            add a contact, an appointment, an invoice line
 *   <action>                   every module action, under its own catalogue name, taken
 *                              on one record: { id, ...its params }
 *
 * Every action name is unique across the module catalogue, so a tool name means the same
 * thing in every business — `issue_invoice` is issuing an invoice at a clinic and at a
 * caterer, and a policy written against it means the same thing at both.
 */
import type { AppAction, AppColumn, AppEntity, AppManifest } from "../builder/appManifest.js";
import type { Effect, FieldDef } from "../modules/types.js";

export type ToolKind = "read" | "create" | "action";

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, JsonSchema>; required: string[] };
  kind: ToolKind;
  /** The entity it reads, creates or acts on. */
  entity?: string;
  /** For actions: what it touches and who approves it — what a policy is written from. */
  effects?: Effect[];
  policy?: AppAction["policy"];
}

type JsonSchema = { type: string; description?: string; enum?: string[]; items?: JsonSchema; format?: string };

function schemaFor(semantic: string | undefined, storage: string, label: string, help?: string, options?: string[], ref?: string): JsonSchema {
  const description = [label, help, ref ? `the id of a ${ref.replace(/_/g, " ")}` : ""].filter(Boolean).join(" — ");
  if (options?.length) return { type: "string", enum: options, description };
  switch (semantic ?? storage) {
    case "integer": return { type: "integer", description };
    case "number": case "money": case "percent": case "numeric": return { type: "number", description };
    case "boolean": return { type: "boolean", description };
    case "date": return { type: "string", format: "date", description: `${description} (YYYY-MM-DD)` };
    case "datetime": case "timestamp with time zone": return { type: "string", format: "date-time", description: `${description} (ISO 8601)` };
    case "tags": case "text[]": return { type: "array", items: { type: "string" }, description };
    default: return { type: "string", description };
  }
}

const label = (c: { name: string; label?: string }) => c.label ?? c.name.replace(/_id$/, "").replace(/_/g, " ");
const writable = (e: AppEntity) => e.columns.filter((c) => !c.pk && !c.formula && c.name !== e.stageColumn && c.name !== "created_at" && c.name !== "updated_at");

const EFFECT_WORDS: Record<Effect, string> = {
  record: "changes records",
  outbound: "reaches someone outside the business",
  money: "moves or commits money",
  sensitive: "exposes personal data",
  destructive: "hard to undo",
};

function policyWords(p: AppAction["policy"], symbol: string): string {
  if (p.mode === "auto") return "Runs without approval.";
  if (p.mode === "approve") return `Always held for ${p.approver} approval (${p.why}).`;
  const figure = p.measure === "amount" ? `${symbol}${p.limit.toLocaleString("en-IN")}` : `${p.limit}%`;
  return `Held for ${p.approver} approval ${p.trigger === "atOrAbove" ? "at or above" : "beyond"} ${figure}.`;
}

export function toolsFor(app: AppManifest): Tool[] {
  if (app.version !== 2 || !app.actions) throw new Error("tools come from a composed app (app.json version 2)");
  const entities = app.entities;
  const names = entities.map((e) => e.name);
  const sym = app.business.currencySymbol;
  const tools: Tool[] = [
    {
      name: "find_records",
      kind: "read",
      description: `Search one kind of record in ${app.business.name}. Returns up to 20, newest first, each with its id, title, stage and linked names. Kinds: ${entities.map((e) => `${e.name} (${e.label})`).join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", enum: names, description: "which kind of record" },
          query: { type: "string", description: "words to match in any field, e.g. a name or phone number" },
          stage: { type: "string", description: "only records in this stage" },
        },
        required: ["entity"],
      },
    },
    {
      name: "get_record",
      kind: "read",
      description: "Read one record in full: its fields, its stage, what points at it, and the actions that are legal on it right now with whether each needs approval.",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", enum: names, description: "which kind of record" },
          id: { type: "string", description: "the record's id, e.g. DEN-INV-0004" },
        },
        required: ["entity", "id"],
      },
    },
  ];

  for (const e of entities) {
    const cols = writable(e);
    tools.push({
      name: `create_${e.name}`,
      kind: "create",
      entity: e.name,
      description: `Create a ${(e.singular ?? e.label).toLowerCase()}: ${e.purpose}.${e.lifecycle ? ` It starts as "${e.lifecycle.states[e.lifecycle.initial]?.label ?? e.lifecycle.initial}".` : ""}`,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(cols.map((c: AppColumn) => [c.name, schemaFor(c.semantic, c.type, label(c), c.help, c.options, c.links)])),
        required: cols.filter((c) => c.required).map((c) => c.name),
      },
    });
  }

  for (const a of app.actions) {
    const e = entities.find((x) => x.name === a.entity);
    if (!e) continue;
    const where = e.lifecycle && a.when ? ` Only when the ${(e.singular ?? e.label).toLowerCase()} is ${a.when.map((s) => e.lifecycle!.states[s]?.label ?? s).join(" or ")}.` : "";
    const params = a.params ?? [];
    tools.push({
      name: a.name,
      kind: "action",
      entity: a.entity,
      effects: a.effects,
      policy: a.policy,
      description: `${a.label} — ${a.summary} Taken on a ${(e.singular ?? e.label).toLowerCase()}.${where} ${policyWords(a.policy, sym)} ${a.effects.map((x) => EFFECT_WORDS[x]).join("; ")}.`.replace(/\s+/g, " ").trim(),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: `the id of the ${(e.singular ?? e.label).toLowerCase()}` },
          ...Object.fromEntries(params.map((p: FieldDef) => [p.name, schemaFor(p.type, p.type, label(p), p.help, p.options, p.ref)])),
        },
        required: ["id", ...params.filter((p) => p.required).map((p) => p.name)],
      },
    });
  }
  return tools;
}
