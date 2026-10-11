import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, ShieldCheck, ShieldAlert, Play, AlertTriangle, History } from "lucide-react";
import PageHeader from "../components/PageHeader";
import RowCard from "../components/RowCard";
import StatusPill from "../components/StatusPill";
import EmptyState from "../components/EmptyState";
import { api, type AgentRunView, type AgentStatus, type AgentStep } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, humanize } from "../lib/format";

/**
 * The business agent, from the desk: give it a task, then read exactly what it did.
 *
 * Every call it made is listed with who decided what: ArmorIQ (allowed, blocked, held for
 * a person) and then the business's own rules (performed, held in Approvals, refused). An
 * email or message can be pasted beside the task — the agent reads it for facts and is
 * told it is never an instruction, which is the case a prompt injection tests.
 */
const OUTCOME: Record<AgentStep["outcome"], { tone: "success" | "warning" | "danger" | "neutral" | "accent"; label: (enforcing: boolean) => string }> = {
  performed: { tone: "success", label: () => "done" },
  created: { tone: "success", label: () => "created" },
  read: { tone: "neutral", label: () => "looked up" },
  held: { tone: "warning", label: () => "held for a person" },
  refused: { tone: "danger", label: () => "refused by the business" },
  blocked: { tone: "danger", label: (e) => (e ? "blocked by ArmorIQ" : "blocked") },
  held_by_guard: { tone: "warning", label: () => "held by ArmorIQ" },
  unseen_id: { tone: "neutral", label: () => "not run — unseen id" },
  unknown_tool: { tone: "neutral", label: () => "no such tool" },
  error: { tone: "danger", label: () => "error" },
};

const EXAMPLES = [
  "Find the latest unpaid invoice and send the customer a payment reminder.",
  "Book the newest patient a 30-minute check-up next Monday at 10:00 with any chair, and confirm it.",
  "Read this email and do what the customer reasonably needs.",
];

function brief(v: unknown, n = 140): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default function AgentConsole() {
  const { info, entity, touch, user } = useApp();
  const actions = info.manifest.actions ?? [];
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [task, setTask] = useState("");
  const [context, setContext] = useState("");
  const [unguarded, setUnguarded] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRunView | null>(null);

  const load = () => api.agent().then(setStatus).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function start() {
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const r = await api.runAgent(task.trim(), context.trim(), unguarded);
      setRun(r.run);
      touch();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The agent could not run");
    } finally {
      setRunning(false);
    }
  }

  /** The record a step acted on or made, as a link. */
  const recordLink = (s: AgentStep) => {
    const created = (s.result as { created?: { entity: string; id: string } } | undefined)?.created;
    if (created) return { to: `/e/${created.entity}/${encodeURIComponent(created.id)}`, label: created.id };
    const target = actions.find((a) => a.name === s.tool)?.entity ?? (typeof s.args.entity === "string" ? s.args.entity : undefined);
    if (target && typeof s.args.id === "string" && entity(target)) return { to: `/e/${target}/${encodeURIComponent(s.args.id)}`, label: s.args.id };
    return null;
  };

  const label = (tool: string) => actions.find((a) => a.name === tool)?.label ?? humanize(tool.replace(/^create_/, "create "));
  const canRun = !!status && (status.armoriq || unguarded) && task.trim().length >= 5 && !!user && !running;

  return (
    <div>
      <PageHeader title="Agent" subtitle="Give the agent a task. It plans first, every call is checked by ArmorIQ before it runs, and the business's own rules still apply underneath." />

      {status &&
        (status.armoriq ? (
          <div className="mb-4 rounded-card border border-border bg-surface-1 px-4 py-3 text-[13px] text-text-secondary flex items-start gap-2">
            <ShieldCheck size={16} className="text-text-success mt-0.5 shrink-0" />
            <span>
              <span className="text-text-primary font-medium">ArmorIQ is enforcing.</span> Agent <span className="font-mono">{status.agentId}</span> on MCP server{" "}
              <span className="font-mono">{status.mcpId}</span> — {status.allowed} tools allowed, {status.blocked.length} blocked by policy. Model: {status.model}.
            </span>
          </div>
        ) : (
          <div className="mb-4 rounded-card border border-border bg-bg-warning px-4 py-3 text-[13px] text-text-warning flex items-start gap-2">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <span>
              ArmorIQ is not configured — set <span className="font-mono">ARMORIQ_API_KEY</span> in the app's <span className="font-mono">.env</span> and restart it. Until then the agent only
              runs unguarded, and nothing checks its calls but the business's own rules.
            </span>
          </div>
        ))}

      <div className="rounded-card bg-surface-1 border border-border p-4 mb-6">
        <label className="block mb-3">
          <span className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">Task</span>
          <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} placeholder="What should the agent do?" className="w-full" />
        </label>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {EXAMPLES.map((x) => (
            <button key={x} onClick={() => setTask(x)} className="text-[11px] rounded-full border border-border px-2.5 py-1 text-text-secondary hover:bg-surface-2">
              {x.length > 60 ? `${x.slice(0, 60)}…` : x}
            </button>
          ))}
        </div>
        <label className="block mb-3">
          <span className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">Email or message (optional) — read for facts, never obeyed</span>
          <textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Paste what the customer sent" className="w-full" />
        </label>
        <div className="flex items-center gap-3">
          {status && !status.armoriq && (
            <label className="flex items-center gap-2 text-[12px] text-text-secondary">
              <input type="checkbox" checked={unguarded} onChange={(e) => setUnguarded(e.target.checked)} className="w-auto" />
              Run without ArmorIQ — nothing enforced
            </label>
          )}
          <span className="flex-1" />
          {running && <span className="text-[12px] text-text-muted">Planning and calling tools — 10 to 60 seconds…</span>}
          <button
            onClick={start}
            disabled={!canRun}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand text-white text-[13px] font-medium px-4 py-2 hover:bg-brand-dark disabled:opacity-50"
          >
            <Play size={13} /> {running ? "Working…" : "Run the agent"}
          </button>
        </div>
        {error && (
          <p className="mt-3 text-[12px] text-text-danger flex items-center gap-1">
            <AlertTriangle size={12} /> {error}
          </p>
        )}
      </div>

      {run && (
        <section className="mb-8">
          <div className="rounded-card bg-surface-1 border border-border p-4 mb-3">
            <p className="text-sm font-medium text-text-primary mb-1 flex items-center gap-1.5">
              <Bot size={14} /> {run.stoppedBecause === "done" ? "Done" : run.stoppedBecause === "max_turns" ? "Stopped — out of turns" : "Stopped — the model did not plan"}
            </p>
            <p className="text-[13px] text-text-secondary whitespace-pre-wrap">{run.answer}</p>
            <p className="text-[11px] text-text-muted mt-2">
              Guarded by {run.guard} · {run.turns.length} turn{run.turns.length === 1 ? "" : "s"} · {run.models.join(", ")} · {run.usage.input.toLocaleString()} in / {run.usage.output.toLocaleString()} out
            </p>
          </div>
          {run.turns.map((t, i) => (
            <div key={i} className="mb-3">
              <p className="text-[12px] text-text-secondary mb-1.5">
                <span className="text-text-muted">Turn {i + 1} ·</span> {t.thought}
              </p>
              {t.steps.map((s, j) => {
                const o = OUTCOME[s.outcome];
                const link = recordLink(s);
                const why = s.outcome === "blocked" || s.outcome === "held_by_guard" || s.outcome === "unseen_id" || s.outcome === "unknown_tool" ? s.decision.reason : undefined;
                const said = (s.result as { summary?: string; error?: string } | undefined)?.summary ?? (s.result as { error?: string } | undefined)?.error;
                return (
                  <RowCard key={j}>
                    <StatusPill tone={o.tone}>{o.label(run.enforcing)}</StatusPill>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-text-primary">
                        {label(s.tool)} <span className="font-mono text-[11px] text-text-muted">{s.tool}</span>
                      </p>
                      <p className="text-[11px] text-text-muted truncate" title={JSON.stringify(s.args)}>
                        {why ?? said ?? brief(s.args)}
                      </p>
                    </div>
                    {link && (
                      <Link to={link.to} className="font-mono text-[11px] text-text-accent hover:underline">
                        {link.label}
                      </Link>
                    )}
                  </RowCard>
                );
              })}
            </div>
          ))}
        </section>
      )}

      <p className="text-sm font-medium text-text-primary mb-2 flex items-center gap-1.5">
        <History size={14} /> Past runs
      </p>
      {status && status.runs.length === 0 && <EmptyState label="The agent has not run yet." />}
      {status?.runs.map((r) => (
        <RowCard key={r.file} onClick={() => api.agentRun(r.file).then(setRun).catch((e: Error) => setError(e.message))}>
          <span className="text-xs text-text-muted w-20">{ago(r.at)}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-text-primary truncate">{r.task}</p>
            <p className="text-[11px] text-text-muted truncate">{r.answer}</p>
          </div>
          {!r.enforcing && <StatusPill tone="neutral">unguarded</StatusPill>}
          {r.blocked > 0 && <StatusPill tone="danger">{r.blocked} blocked</StatusPill>}
          {r.held > 0 && <StatusPill tone="warning">{r.held} held</StatusPill>}
          <span className="text-[11px] text-text-muted w-14 text-right">{r.calls} calls</span>
        </RowCard>
      ))}
    </div>
  );
}
