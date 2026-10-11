/**
 * The app's backend, typed. Same role as the CRM's services/backend.ts, pointed at the
 * built business's own server instead of the freight Edge Functions.
 */

import { apiUrl } from "./base";

export type Row = Record<string, unknown>;

export interface Column {
  name: string;
  type: string;
  from?: string;
  pk?: boolean;
  links?: string;
  leftover?: boolean;
  // Composed apps say what a column is, not just how it is stored.
  label?: string;
  semantic?: string;
  options?: string[];
  required?: boolean;
  formula?: string;
  pii?: boolean;
  help?: string;
}

export type Role = "primary" | "calls" | "events" | "slots" | "bookings" | "partners" | "quotes" | "lines" | "other";

export interface EntityLifecycle {
  order: string[];
  initial: string;
  states: Record<string, { label: string; requirements?: string[]; next: string[] }>;
}

export interface Entity {
  name: string;
  label: string;
  purpose: string;
  from: string | null;
  role: Role;
  key: string;
  title: string;
  columns: Column[];
  // Composed apps: any entity may have stages of its own.
  module?: string;
  singular?: string;
  lifecycle?: EntityLifecycle;
  stageColumn?: string;
}

/** An input an action asks for. */
export interface Param {
  name: string;
  type: string;
  label?: string;
  help?: string;
  required?: boolean;
  options?: string[];
  ref?: string;
}

export type Policy =
  | { mode: "auto" }
  | { mode: "approve"; approver: string; why: string }
  | { mode: "threshold"; measure: "amount" | "discountPct"; limit: number; trigger: "atOrAbove" | "above"; approver: string };

export interface AppModule {
  id: string;
  label: string;
  category: string;
  icon: string;
  summary: string;
  entities: string[];
  settings: Record<string, string | number | boolean>;
}

export interface AppAction {
  name: string;
  label: string;
  entity: string;
  module: string;
  summary: string;
  effects: string[];
  policy: Policy;
  params?: Param[];
  custom?: boolean;
}

export interface StateDef {
  label: string;
  requirements: string[];
  actions: string[];
  next: string[];
}

export interface Vertical {
  id: string;
  label: string;
  business: { name: string; currency: string; currencySymbol: string; locale: string; timezone: string };
  lifecycle: { order: string[]; initial: string; states: Record<string, StateDef> };
  actions: string[];
  policy: {
    alwaysApprove: Record<string, { why: string; approver: string }>;
    thresholds: Array<{ actions: string[]; measure: "amount" | "discountPct"; limit: number; trigger: "atOrAbove" | "above"; approver: string }>;
  };
}

export interface Manifest {
  /** 1: cloned from the freight template. 2: composed from the module catalogue. */
  version: 1 | 2;
  business: Vertical["business"];
  vertical: Vertical;
  modules?: AppModule[];
  actions?: AppAction[];
  primary: { entity: string; stageColumn: string | null };
  entities: Entity[];
  agents: Array<{ name: string; from: string; role: string; greeting: string; collects: string[]; promptFile: string }>;
  workflows: Array<{ file: string; name: string; from: string }>;
  memory: { dataset: string; domains: string[] };
  openQuestions: Array<{ question: string; blocks: "structure" | "behaviour" }>;
  template: string;
}

export interface AppInfo {
  build: string;
  buildDir: string;
  startedAt: string;
  port: number;
  manifest: Manifest;
  agents: Array<Manifest["agents"][number] & { prompt: string; config: Record<string, unknown> }>;
  workflows: Array<Manifest["workflows"][number] & { nodes: number; trigger: string; webhooks: string[]; calls: string[]; steps: string[] }>;
  buildMd: string;
}

export type Verdict = { autonomy: "alone" } | { autonomy: "approve"; why: string; approver: string };

export interface LedgerEntry {
  id: string;
  at: string;
  by: string;
  kind: string;
  entity: string;
  recordId: string | null;
  action?: string;
  from?: string;
  to?: string;
  verdict?: Verdict;
  summary: string;
}

export interface Approval {
  id: string;
  at: string;
  requestedBy: string;
  entity: string;
  recordId: string;
  action: string;
  context: { amount?: number; discountPct?: number; note?: string };
  params?: Record<string, unknown>;
  why: string;
  approver: string;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
  // Composed apps name what is waiting, so the queue reads without opening each one.
  entityLabel?: string;
  actionLabel?: string;
  title?: string;
}

export interface ActionOption {
  action: string;
  verdict: Verdict;
  // Composed apps describe each action and what it asks for.
  label?: string;
  summary?: string;
  effects?: string[];
  params?: Param[];
  policy?: Policy;
  custom?: boolean;
}

export interface Lifecycle {
  /** Null for a composed record with actions but no stages — a contact, a stock item. */
  state: string | null;
  label: string | null;
  readiness: number;
  requirements: Record<string, boolean>;
  unmet: string[];
  next: Array<{ state: string; label: string }>;
  actions: ActionOption[];
  history: Array<{ from: string | null; to: string; at: string; why: string }>;
  pendingApprovals: Approval[];
  entity?: string;
  /** Composed apps: only the business's own pipeline is moved by hand. */
  movable?: boolean;
}

export interface RecordView {
  row: Row;
  related: Array<{ entity: string; label: string; column: string; rows: Row[] }>;
  lifecycle: Lifecycle | null;
  activity: LedgerEntry[];
}

export interface Overview {
  counts: Record<string, number>;
  byState: Record<string, number>;
  pendingApprovals: number;
  actionsToday: number;
  recent: LedgerEntry[];
  newest: Row[];
}

// ---------------------------------------------------------------- the agent (composed apps)

export interface AgentStep {
  tool: string;
  args: Record<string, unknown>;
  decision: { action: "allow" | "hold" | "block"; reason?: string; delegationId?: string; matchedPolicy?: string };
  outcome: "performed" | "held" | "refused" | "read" | "created" | "error" | "blocked" | "held_by_guard" | "unknown_tool" | "unseen_id";
  result?: unknown;
}

export interface AgentRunView {
  at?: string;
  task: string;
  guard: string;
  enforcing: boolean;
  turns: Array<{ thought: string; steps: AgentStep[] }>;
  answer: string;
  stoppedBecause: "done" | "max_turns" | "model_error";
  usage: { input: number; output: number };
  models: string[];
}

export interface AgentStatus {
  armoriq: boolean;
  model: string;
  agentId: string;
  mcpId: string;
  allowed: number;
  blocked: Array<{ tool: string; why: string }>;
  busy: boolean;
  runs: Array<{ file: string; at: string; task: string; guard: string; enforcing: boolean; answer: string; stoppedBecause: string; calls: number; blocked: number; held: number; refused: number }>;
}

export class ApiError extends Error {}

let deskUser = "";
export function setDeskUser(name: string) {
  deskUser = name;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(deskUser ? { "x-desk-user": deskUser } : {}), ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* empty body */
  }
  if (!r.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return body as T;
}

const send = <T,>(method: string, path: string, body: unknown) => call<T>(path, { method, body: JSON.stringify(body) });

export const api = {
  app: () => call<AppInfo>("/api/app"),
  overview: () => call<Overview>("/api/overview"),
  rows: (entity: string, params: { q?: string; stage?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as Array<[string, string]>).toString();
    return call<Row[]>(`/api/e/${encodeURIComponent(entity)}${qs ? `?${qs}` : ""}`);
  },
  record: (entity: string, id: string) => call<RecordView>(`/api/e/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`),
  create: (entity: string, values: Row) => send<Row>("POST", `/api/e/${encodeURIComponent(entity)}`, { values }),
  update: (entity: string, id: string, values: Row) => send<Row>("PATCH", `/api/e/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, { values }),
  requirement: (id: string, requirement: string, met: boolean) => send<Lifecycle>("POST", `/api/records/${encodeURIComponent(id)}/requirements`, { requirement, met }),
  advance: (id: string, to: string, why: string, force: boolean) => send<Lifecycle>("POST", `/api/records/${encodeURIComponent(id)}/advance`, { to, why, force }),
  act: (id: string, action: string, ctx: { amount?: string; discountPct?: string; note?: string }) =>
    send<{ outcome: "performed" | "held" | "refused"; entry: LedgerEntry; approval?: Approval; options: Lifecycle }>("POST", `/api/records/${encodeURIComponent(id)}/act`, { action, ...ctx }),
  // Composed apps: any record with stages or actions, not just the primary.
  actOn: (entity: string, id: string, action: string, params: Record<string, unknown>) =>
    send<{ outcome: "performed" | "held" | "refused"; entry: LedgerEntry; approval?: Approval; created?: { entity: string; id: string }; options: Lifecycle }>(
      "POST",
      `/api/e/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/act`,
      { action, params },
    ),
  advanceOn: (entity: string, id: string, to: string, why: string, force: boolean) =>
    send<Lifecycle>("POST", `/api/e/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/advance`, { to, why, force }),
  requirementOn: (entity: string, id: string, requirement: string, met: boolean) =>
    send<Lifecycle>("POST", `/api/e/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/requirements`, { requirement, met }),
  agent: () => call<AgentStatus>("/api/agent"),
  agentRun: (file: string) => call<AgentRunView>(`/api/agent/runs/${encodeURIComponent(file)}`),
  runAgent: (task: string, context: string, unguarded: boolean) =>
    send<{ file: string; run: AgentRunView }>("POST", "/api/agent/run", { task, context, unguarded }),
  approvals: () => call<Approval[]>("/api/approvals"),
  decide: (id: string, approve: boolean) => send<Approval>("POST", `/api/approvals/${encodeURIComponent(id)}`, { approve }),
  ledger: (limit = 300) => call<LedgerEntry[]>(`/api/ledger?limit=${limit}`),
  sample: () => send<{ created: Record<string, number> }>("POST", "/api/sample", {}),
};
