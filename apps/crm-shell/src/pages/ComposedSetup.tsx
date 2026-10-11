import { ArrowRight, Boxes, HelpCircle, ShieldAlert, Package } from "lucide-react";
import PageHeader from "../components/PageHeader";
import StatusPill from "../components/StatusPill";
import { useApp } from "../lib/app";
import { iconFor } from "../lib/icons";
import { humanize, money } from "../lib/format";
import type { Policy } from "../lib/api";

/**
 * How a composed business is put together: which modules, in its own words, with their
 * settings; every entity's stages; and every action that waits for a person, and why.
 * All of it is read from app.json, which is composed from config.json — the page says so,
 * because that one file is where a change to any of this is made.
 */
export default function ComposedSetup() {
  const { info } = useApp();
  const m = info.manifest;
  const v = m.vertical;
  const entity = (n: string) => m.entities.find((e) => e.name === n);
  const policyText = (p: Policy) =>
    p.mode === "approve"
      ? `always — ${p.why}`
      : p.mode === "threshold"
        ? `${p.trigger === "atOrAbove" ? "at or above" : "beyond"} ${p.measure === "amount" ? money(v, p.limit) : `${p.limit}%`}`
        : "";
  const held = (m.actions ?? []).filter((a) => a.policy.mode !== "auto");
  const custom = (m.actions ?? []).filter((a) => a.custom);

  return (
    <div>
      <PageHeader
        title="Business setup"
        subtitle={`${m.business.name} · ${v.label} · ${m.modules?.length ?? 0} modules · ${m.business.currency} · ${m.business.timezone}`}
      />

      <div className="rounded-card bg-surface-1 border border-border p-4 mb-4">
        <p className="text-sm font-medium text-text-primary mb-1 flex items-center gap-1.5">
          <Boxes size={14} /> Modules
        </p>
        <p className="text-[12px] text-text-muted mb-3">
          Composed from the module catalogue. To change any of this, edit <span className="font-mono">{info.buildDir}/config.json</span> and compose again.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {(m.modules ?? []).map((mod) => {
            const Icon = iconFor(mod.icon);
            return (
              <div key={mod.id} className="rounded border border-border px-3 py-2.5">
                <p className="text-[13px] text-text-primary font-medium flex items-center gap-1.5">
                  <Icon size={14} /> {mod.label} <span className="font-mono text-[11px] text-text-muted font-normal">{mod.id}</span>
                </p>
                <p className="text-[12px] text-text-secondary mt-0.5">{mod.summary}</p>
                <p className="text-[11px] text-text-muted mt-1">{mod.entities.map((n) => entity(n)?.label ?? n).join(" · ")}</p>
                {Object.keys(mod.settings).length > 0 && (
                  <p className="text-[11px] text-text-muted mt-1">
                    {Object.entries(mod.settings).map(([k, val]) => `${humanize(k)}: ${String(val)}`).join(" · ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-card bg-surface-1 border border-border p-4 mb-4">
        <p className="text-sm font-medium text-text-primary mb-3">Stages — each runs on the same state machine</p>
        <div className="flex flex-col gap-3">
          {m.entities.filter((e) => e.lifecycle).map((e) => (
            <div key={e.name}>
              <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1.5">
                {e.label}
                {e.name === m.primary.entity && <span className="normal-case tracking-normal"> · the board</span>}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {e.lifecycle!.order.map((s, i) => (
                  <span key={s} className="flex items-center gap-1.5">
                    <span className={`rounded-lg border px-2.5 py-1 text-[12px] ${s === e.lifecycle!.initial ? "border-border-strong bg-bg-accent text-text-accent" : "border-border bg-surface-2 text-text-primary"}`}>
                      {e.lifecycle!.states[s]?.label ?? s}
                    </span>
                    {i < e.lifecycle!.order.length - 1 && <ArrowRight size={12} className="text-text-muted" />}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-3 flex items-center gap-1.5">
            <ShieldAlert size={14} /> What waits for a person
          </p>
          <ul className="flex flex-col gap-1.5">
            {held.map((a) => (
              <li key={a.name} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                <span className="text-text-primary">{a.label}</span> on {entity(a.entity)?.label.toLowerCase()} — {policyText(a.policy)}{" "}
                <StatusPill tone="warning">{a.policy.mode === "auto" ? "" : a.policy.approver}</StatusPill>
              </li>
            ))}
            {held.length === 0 && <li className="text-[13px] text-text-muted">Nothing — every action acts alone.</li>}
          </ul>
        </div>

        <div className="rounded-card bg-surface-1 border border-border p-4">
          <p className="text-sm font-medium text-text-primary mb-3 flex items-center gap-1.5">
            <Package size={14} /> This business's own actions
          </p>
          <ul className="flex flex-col gap-1.5">
            {custom.map((a) => (
              <li key={a.name} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                <span className="text-text-primary">{a.label}</span> — {a.summary}
              </li>
            ))}
            {custom.length === 0 && <li className="text-[13px] text-text-muted">None — it runs on the modules' own actions.</li>}
          </ul>
          <p className="text-sm font-medium text-text-primary mt-5 mb-2 flex items-center gap-1.5">
            <HelpCircle size={14} /> Still open
          </p>
          <ul className="flex flex-col gap-1.5">
            {m.openQuestions.map((q, i) => (
              <li key={i} className="text-[13px] text-text-secondary pl-3 border-l-2 border-border">
                {q.question} {q.blocks === "structure" && <StatusPill tone="warning">changes what is built</StatusPill>}
              </li>
            ))}
            {m.openQuestions.length === 0 && <li className="text-[13px] text-text-muted">Nothing open.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
