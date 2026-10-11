/**
 * The guard between an agent's plan and its tool calls.
 *
 *   declare(calls)   the agent commits, before anything runs, to what it intends to call
 *   check(call)      may this call run — allow, hold for a person, or block
 *   report(call, …)  what happened, for the audit trail
 *
 * Two layers decide different things, and the agent goes through both:
 *
 *   ArmorIQ   may THIS AGENT do this kind of thing at all, and was it in the plan it
 *             signed? A call the plan did not declare — the extra step a prompt-injected
 *             email slips in — is blocked before it reaches the business.
 *   the kernel (ModuleEngine, behind the MCP server) is it legal for this record now, and
 *             does a person approve it? The same rules a person at the desk meets.
 *
 * `ArmorIQGuard` is the real one, through ArmorIQ's SDK in sdk mode: the plan is minted
 * into a signed intent token, every call is checked against it and against the policies
 * stored on platform.armoriq.ai, and the agent then calls the MCP server itself.
 * `UnguardedGuard` lets everything through and says so on every line; it exists for running
 * the agent offline, and is never what a demo of enforcement uses.
 */
import { ArmorIQClient, type ArmorIQSession } from "@armoriq/sdk";

export interface PlannedCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Decision {
  action: "allow" | "hold" | "block";
  reason?: string;
  /** ArmorIQ's delegation request, when it held the call for a person. */
  delegationId?: string;
  matchedPolicy?: string;
}

export interface Guard {
  readonly name: string;
  /** True only for a guard that actually enforces something. */
  readonly enforcing: boolean;
  declare(calls: PlannedCall[], goal: string): Promise<void>;
  check(call: PlannedCall): Promise<Decision>;
  report(call: PlannedCall, result: unknown, ok: boolean): Promise<void>;
  close(status: "ok" | "error" | "denied"): Promise<void>;
}

export interface ArmorIQOptions {
  apiKey: string;
  /** The agent as registered on platform.armoriq.ai. */
  agentId: string;
  /** The service the agent runs as. */
  userId: string;
  /** The person on whose behalf it acts — what per-member policies are evaluated against. */
  userEmail?: string;
  /** The MCP server's id as registered on the platform; tools are its actions. */
  mcpName: string;
  /** The model that planned, for the intent record. */
  llm?: string;
}

export class ArmorIQGuard implements Guard {
  readonly name = "ArmorIQ";
  readonly enforcing = true;
  private session: ArmorIQSession;

  constructor(private opts: ArmorIQOptions) {
    const client = new ArmorIQClient({ apiKey: opts.apiKey, userId: opts.userId, agentId: opts.agentId });
    this.session = client.startSession({ mode: "sdk", defaultMcpName: opts.mcpName, validitySeconds: 900, llm: opts.llm ?? "agent" });
  }

  async declare(calls: PlannedCall[], goal: string): Promise<void> {
    await this.session.startPlan(calls.map((c) => ({ name: c.tool, args: c.args })), goal);
  }

  async check(call: PlannedCall): Promise<Decision> {
    const r = await this.session.check(call.tool, call.args, this.opts.userEmail);
    return { action: r.action, reason: r.reason, delegationId: r.delegationId, matchedPolicy: r.matchedPolicy };
  }

  async report(call: PlannedCall, result: unknown, ok: boolean): Promise<void> {
    try {
      await this.session.report(call.tool, call.args, result, ok ? { status: "success" } : { status: "failed", errorMessage: typeof result === "string" ? result : JSON.stringify(result).slice(0, 500) });
    } catch {
      /* the audit copy at ArmorIQ is best effort; the business's own ledger already has it */
    }
  }

  async close(status: "ok" | "error" | "denied"): Promise<void> {
    try { await this.session.close(status); } catch { /* best effort */ }
  }
}

export class UnguardedGuard implements Guard {
  readonly name = "UNGUARDED (no ArmorIQ)";
  readonly enforcing = false;
  async declare(): Promise<void> {}
  async check(): Promise<Decision> {
    return { action: "allow", reason: "no guard — set ARMORIQ_API_KEY to enforce" };
  }
  async report(): Promise<void> {}
  async close(): Promise<void> {}
}
