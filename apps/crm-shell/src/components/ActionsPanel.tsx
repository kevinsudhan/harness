import { useState } from "react";
import { Link } from "react-router-dom";
import { Zap, ShieldAlert, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import StatusPill from "./StatusPill";
import { Field } from "./RecordForm";
import { api, type ActionOption, type Lifecycle, type Policy, type Vertical } from "../lib/api";
import { useApp } from "../lib/app";
import { humanize, money, paramColumn } from "../lib/format";

/**
 * What can be done to this record right now, and what each would need.
 *
 * Only the current state's legal actions are offered — the twin's gate, visible. Each one
 * shows the policy verdict before it is clicked: "acts alone", or which person must
 * approve and why. An action that needs approval is not refused when taken; it is held
 * and appears in Approvals, the template's rule for autonomy with a brake.
 *
 * In a composed app every record with actions gets this panel — an invoice, a contact, a
 * stock item — and each action brings its own inputs (an amount, a reason, a new time)
 * from the module that declares it. An action with no inputs is one click.
 */
const EFFECT_WORDS: Record<string, string> = {
  outbound: "reaches the customer",
  money: "moves money",
  sensitive: "personal data",
  destructive: "hard to undo",
};

function policyPill(p: Policy | undefined, v: Vertical) {
  if (!p || p.mode === "auto") return null;
  if (p.mode === "approve") return null;
  const figure = p.measure === "amount" ? money(v, p.limit) : `${p.limit}%`;
  return <StatusPill tone="accent">approval {p.trigger === "atOrAbove" ? "from" : "above"} {figure}</StatusPill>;
}

export default function ActionsPanel({
  entity,
  id,
  lifecycle,
  onChanged,
}: {
  /** Composed apps: the record's entity. Without it, the template's primary-record routes are used. */
  entity?: string;
  id: string;
  lifecycle: Lifecycle;
  onChanged: (l: Lifecycle) => void;
}) {
  const { info, touch } = useApp();
  const v = info.manifest.vertical;
  const composed = info.manifest.version === 2 && !!entity;
  const [open, setOpen] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "danger"; text: string; link?: { to: string; label: string } } | null>(null);

  const thresholdFor = (action: string) => v.policy.thresholds.find((t) => t.actions.includes(action));
  const labelOf = (o: ActionOption) => o.label ?? humanize(o.action);

  async function take(o: ActionOption) {
    setBusy(true);
    setResult(null);
    try {
      const params = Object.fromEntries(Object.entries(inputs).filter(([, x]) => x !== ""));
      const r = composed
        ? await api.actOn(entity!, id, o.action, params)
        : await api.act(id, o.action, { amount: (inputs.amount as string) || undefined, note: (inputs.note as string) || undefined });
      touch();
      onChanged(r.options);
      const created = "created" in r ? (r as { created?: { entity: string; id: string } }).created : undefined;
      setResult(
        r.outcome === "performed"
          ? {
              tone: "success",
              text: `${labelOf(o)} — done and recorded.`,
              ...(created ? { link: { to: `/e/${created.entity}/${encodeURIComponent(created.id)}`, label: `Open ${created.id}` } } : {}),
            }
          : r.outcome === "held"
            ? { tone: "warning", text: `${labelOf(o)} is held for ${r.approval?.approver}: ${r.approval?.why}. It is in Approvals.` }
            : { tone: "danger", text: r.entry.summary },
      );
      setOpen(null);
      setInputs({});
    } catch (e) {
      setResult({ tone: "danger", text: e instanceof Error ? e.message : "Could not take the action" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card bg-surface-1 border border-border p-4">
      <p className="text-sm font-medium text-text-primary mb-1 flex items-center gap-1.5">
        <Zap size={14} /> {lifecycle.label ? `Actions in “${lifecycle.label}”` : "Actions"}
      </p>
      <p className="text-[11px] text-text-muted mb-3">
        {lifecycle.label ? "Only what this stage allows." : "What can be done to this record."} Each shows whether it runs alone or waits for a person.
      </p>

      {lifecycle.pendingApprovals.length > 0 && (
        <div className="mb-3 rounded border border-border bg-bg-warning px-3 py-2 text-[12px] text-text-warning flex items-start gap-1.5">
          <Clock size={13} className="mt-0.5 shrink-0" />
          <span>
            Waiting for approval:{" "}
            {lifecycle.pendingApprovals.map((a) => `${info.manifest.actions?.find((x) => x.name === a.action)?.label ?? humanize(a.action)} (${a.approver})`).join(", ")}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {lifecycle.actions.map((o) => {
          const { action, verdict } = o;
          const t = composed ? undefined : thresholdFor(action);
          const params = o.params ?? [];
          const instant = composed && params.length === 0;
          const effects = (o.effects ?? []).filter((x) => EFFECT_WORDS[x]);
          return (
            <div key={action} className="rounded border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-[13px] text-text-primary">{labelOf(o)}</span>
                  {o.custom && <span className="ml-1.5 text-[10px] text-text-muted">this business</span>}
                  {composed && o.summary && <p className="text-[11px] text-text-muted truncate" title={o.summary}>{o.summary}</p>}
                </div>
                {verdict.autonomy === "approve" ? (
                  <StatusPill tone="warning">
                    <ShieldAlert size={11} /> {verdict.approver} approves
                  </StatusPill>
                ) : composed ? (
                  policyPill(o.policy, v) ?? <StatusPill tone="success">acts alone</StatusPill>
                ) : t ? (
                  <StatusPill tone="accent">approval above {t.measure === "amount" ? money(v, t.limit) : `${t.limit}%`}</StatusPill>
                ) : (
                  <StatusPill tone="success">acts alone</StatusPill>
                )}
                <button
                  onClick={() => (instant ? take(o) : setOpen(open === action ? null : action))}
                  disabled={busy}
                  className="text-xs font-medium rounded px-2.5 py-1 border border-border hover:bg-surface-2 disabled:opacity-60"
                >
                  {open === action ? "Cancel" : instant ? (verdict.autonomy === "approve" ? "Request" : "Do it") : "Take"}
                </button>
              </div>
              {(verdict.autonomy === "approve" || effects.length > 0) && (
                <p className="text-[11px] text-text-muted mt-1">
                  {verdict.autonomy === "approve" ? verdict.why : ""}
                  {verdict.autonomy === "approve" && effects.length ? " · " : ""}
                  {effects.map((x) => EFFECT_WORDS[x]).join(" · ")}
                </p>
              )}
              {open === action && (
                <div className="mt-2 grid gap-2">
                  {composed ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {params.map((p) => {
                        const col = paramColumn(p);
                        return <Field key={p.name} col={col} value={inputs[p.name] ?? (col.type === "boolean" ? false : "")} onChange={(x) => setInputs((s) => ({ ...s, [p.name]: x }))} />;
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2 items-center">
                      {t && t.measure === "amount" && (
                        <input type="number" value={String(inputs.amount ?? "")} onChange={(e) => setInputs((s) => ({ ...s, amount: e.target.value }))} placeholder={`Amount (${v.business.currency})`} className="w-40" />
                      )}
                      <input value={String(inputs.note ?? "")} onChange={(e) => setInputs((s) => ({ ...s, note: e.target.value }))} placeholder="Note for the record (optional)" className="flex-1 min-w-[180px]" />
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={() => take(o)}
                      disabled={busy}
                      className="rounded bg-brand text-white text-xs font-medium px-3 py-1.5 hover:bg-brand-dark disabled:opacity-60"
                    >
                      {busy ? "Working…" : verdict.autonomy === "approve" ? "Request approval" : "Do it"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {lifecycle.actions.length === 0 && <p className="text-[13px] text-text-secondary">{lifecycle.label ? "No actions in this stage." : "No actions for this record."}</p>}
      </div>

      {result && (
        <p className={`mt-3 text-[12px] flex items-start gap-1.5 ${result.tone === "success" ? "text-text-success" : result.tone === "warning" ? "text-text-warning" : "text-text-danger"}`}>
          {result.tone === "success" ? <CheckCircle2 size={13} className="mt-0.5" /> : <AlertTriangle size={13} className="mt-0.5" />}
          <span>
            {result.text}
            {result.link && (
              <>
                {" "}
                <Link to={result.link.to} className="text-text-accent hover:underline">
                  {result.link.label}
                </Link>
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
