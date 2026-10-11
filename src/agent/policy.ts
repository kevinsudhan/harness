/**
 * The agent's ArmorIQ policy, compiled from the business it works for.
 *
 * ArmorIQ ships hand-written policy packs for two industries. A composed business already
 * says, action by action, what each one touches and who must approve it — so its agent's
 * policy is generated from that, for any business the builder can describe:
 *
 *   allow   looking things up, adding records, and the ordinary actions of the work
 *   block   anything that exposes personal data, cannot be undone, or changes who may
 *           approve what — a person does those, in the app, never the agent
 *   default block: a tool the policy does not name is refused, so a module added later
 *           is closed to the agent until someone opens it
 *
 * Approvals stay where they are. An action the business holds for a person (an invoice
 * over its threshold, a treatment plan) is allowed to the agent here and held by the
 * kernel there, in the business's own approvals queue — one approval, by the person whose
 * role it is, not one at ArmorIQ and another in the app.
 *
 * Two files come out. `policy.yaml` is ArmorIQ's `kind: Policy` document for the Policy
 * Studio (paste or import it, target the agent). `armoriq.yaml` is the config-as-code
 * manifest for `armoriq register`: the agent's identity, its MCP server and the same
 * allow/deny lists in ArmorIQ's `<mcp>.<tool>` form.
 */
import type { AppManifest } from "../builder/appManifest.js";
import { toolsFor, type Tool } from "../mcp/tools.js";

export interface AgentPolicy {
  mcpId: string;
  agentId: string;
  userId: string;
  allow: string[];
  block: Array<{ tool: string; why: string }>;
  policyYaml: string;
  armoriqYaml: string;
  /** The same rules, for a person to read. */
  rulesMd: string;
}

/** Entities whose records are about the team itself — who works here, who may approve. */
const PEOPLE_ENTITIES = new Set(["staff_member"]);

function verdict(t: Tool): { allow: true } | { allow: false; why: string } {
  if (t.kind === "read") return { allow: true };
  if (t.entity && PEOPLE_ENTITIES.has(t.entity)) return { allow: false, why: "changes the team or who may approve — a person's decision" };
  if (t.kind === "create") return { allow: true };
  const fx = t.effects ?? [];
  if (fx.includes("sensitive")) return { allow: false, why: "exposes personal or confidential data" };
  if (fx.includes("destructive")) return { allow: false, why: "hard to undo" };
  return { allow: true };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const yamlList = (items: string[], indent: string) => (items.length ? items.map((i) => `${indent}- ${i}`).join("\n") : `${indent}[]`);

export function agentPolicy(app: AppManifest, opts: { mcpId?: string; agentId?: string; userId?: string; mcpUrl?: string } = {}): AgentPolicy {
  const base = slug(app.vertical.id || app.business.name);
  const mcpId = opts.mcpId ?? base;
  const agentId = opts.agentId ?? `${base}-agent`;
  const userId = opts.userId ?? `${base}-service`;
  const tools = toolsFor(app);
  const allow: string[] = [];
  const block: Array<{ tool: string; why: string }> = [];
  for (const t of tools) {
    const v = verdict(t);
    if (v.allow) allow.push(t.name);
    else block.push({ tool: t.name, why: v.why });
  }

  const policyYaml = [
    `# ArmorIQ policy for the ${app.business.name} agent — generated from the business's modules.`,
    `# Import in Policy Studio (or paste into its YAML editor) and target the agent "${agentId}".`,
    `# Regenerate with: npm run agent -- --policy <build>`,
    "apiVersion: armor.io/v1",
    "kind: Policy",
    "metadata:",
    `  name: "${base}-agent-policy"`,
    `  description: "What the ${app.business.name.replace(/"/g, "")} agent may do through its MCP server. Anything not listed is blocked."`,
    `  orgId: "<your-org-id>"`,
    "  targetType: agent",
    `  targetId: "${agentId}"`,
    "spec:",
    "  priority: 100",
    "  status: active",
    "  defaultEnforcementAction: block",
    "  memberRules:",
    `    "*":`,
    "      enforcementAction: allow_log",
    "      allowedTools:",
    yamlList(allow, "        "),
    "      toolEnforcement:",
    block.length ? block.map((b) => `        ${b.tool}: block   # ${b.why}`).join("\n") : "        {}",
    "",
  ].join("\n");

  const armoriqYaml = [
    "# yaml-language-server: $schema=https://docs.armoriq.ai/schemas/armoriq.schema.json",
    `# The ${app.business.name} agent, as config-as-code. Register with: armoriq register`,
    "version: v1",
    "identity:",
    "  api_key: $ARMORIQ_API_KEY",
    `  user_id: ${userId}`,
    `  agent_id: ${agentId}`,
    "environment: sandbox",
    "mcp_servers:",
    `  - id: ${mcpId}`,
    `    url: ${opts.mcpUrl ?? "https://<where this app is hosted>/mcp"}`,
    `    description: ${app.business.name.replace(/:/g, " -")} — ${app.vertical.label.replace(/:/g, " -")} operations`,
    "    auth:",
    "      type: bearer",
    "      token: $MCP_TOKEN    # the build's .mcp-secret",
    "policy:",
    "  allow:",
    yamlList(allow.map((t) => `${mcpId}.${t}`), "    "),
    "  deny:",
    yamlList(block.map((b) => `${mcpId}.${b.tool}`), "    "),
    "intent:",
    "  ttl_seconds: 900",
    "  require_csrg: true",
    "",
  ].join("\n");

  const rulesMd = [
    `# What the ${app.business.name} agent may do`,
    "",
    `Generated from the business's modules. Enforced by ArmorIQ on every call the agent makes; anything not listed is blocked. Below that, the business's own rules still apply — an action the business holds for a person is held for the agent too.`,
    "",
    `## Allowed (${allow.length})`,
    "",
    ...tools.filter((t) => allow.includes(t.name)).map((t) => `- \`${t.name}\`${t.policy && t.policy.mode !== "auto" ? " — reaches the business's approvals queue when its rule says so" : ""}`),
    "",
    `## Blocked (${block.length})`,
    "",
    ...block.map((b) => `- \`${b.tool}\` — ${b.why}`),
    "",
  ].join("\n");

  return { mcpId, agentId, userId, allow, block, policyYaml, armoriqYaml, rulesMd };
}
