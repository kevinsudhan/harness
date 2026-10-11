import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ChevronLeft, Pencil, History as HistoryIcon, Link2, Plus } from "lucide-react";
import EmptyState from "../components/EmptyState";
import StatusPill, { toneForState } from "../components/StatusPill";
import StagePanel from "../components/StagePanel";
import ActionsPanel from "../components/ActionsPanel";
import Timeline from "../components/Timeline";
import DetailsGrid from "../components/DetailsGrid";
import RowCard from "../components/RowCard";
import Modal from "../components/Modal";
import RecordForm from "../components/RecordForm";
import { api, type RecordView } from "../lib/api";
import { useApp } from "../lib/app";
import { ago, entitySingular, show, stateLabelFor, subtitle } from "../lib/format";

/**
 * One record, in full — the CRM's record page, in the same order on purpose: the stage
 * action on top, then what can be done and the timeline side by side, then the fields,
 * then everything elsewhere that points at this record, then its history.
 *
 * In a composed app any record may have stages and actions of its own — an invoice moves
 * draft → issued → paid, a contact can be marked do-not-contact — so the panels appear for
 * whatever the record has, not only for the primary table. Only the business's own
 * pipeline is moved by hand; a module's records move through their actions.
 */
export default function RecordDetail() {
  const { entity: name = "", id = "" } = useParams();
  const { info, entity, primary, version } = useApp();
  const e = entity(name);
  const v = info.manifest.vertical;
  const composed = info.manifest.version === 2;
  const [view, setView] = useState<RecordView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<{ entity: string; column: string } | null>(null);
  const [leftovers, setLeftovers] = useState(false);
  const navigate = useNavigate();

  async function load() {
    if (!e) return;
    try {
      setView(await api.record(e.name, id));
      setState("ready");
    } catch {
      setState("missing");
    }
  }

  useEffect(() => {
    setState("loading");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, id, version]);

  if (!e) return <EmptyState label={`No table called ${name}.`} />;
  if (state === "loading") return <p className="text-sm text-text-muted py-10">Loading…</p>;
  if (!view) return <EmptyState label={`${entitySingular(e)} ${id} was not found.`} />;

  const { row, lifecycle, related, activity } = view;
  const titleCol = e.columns.find((c) => c.name === e.title);
  const hasLeftovers = e.columns.some((c) => c.leftover);
  const hasStages = !!lifecycle?.state;
  const order = e.lifecycle?.order ?? v.lifecycle.order;
  const showStagePanel = hasStages && (!composed || lifecycle!.movable);
  const showActions = !!lifecycle && (hasStages || lifecycle.actions.length > 0 || lifecycle.pendingApprovals.length > 0);
  const addingTo = adding ? entity(adding.entity) : undefined;

  return (
    <div>
      <Link to={`/e/${e.name}`} className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary mb-4">
        <ChevronLeft size={14} /> {e.label}
      </Link>

      <div className="flex items-start justify-between mb-5 gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-medium text-text-primary">{show(titleCol, row[e.title], v)}</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            <span className="font-mono">{String(row[e.key])}</span>
            {subtitle(e, row, v) ? ` · ${subtitle(e, row, v)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasStages && <StatusPill tone={toneForState(lifecycle!.state, order)}>{stateLabelFor(e, v, lifecycle!.state)}</StatusPill>}
          <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-2">
            <Pencil size={12} /> Edit
          </button>
        </div>
      </div>

      {showStagePanel && <StagePanel entity={composed ? e.name : undefined} id={id} lifecycle={lifecycle!} onChanged={(l) => setView({ ...view, lifecycle: l })} />}
      {showActions && (
        <div className={`grid gap-4 mb-6 ${hasStages ? "lg:grid-cols-2" : ""}`}>
          <ActionsPanel entity={composed ? e.name : undefined} id={id} lifecycle={lifecycle!} onChanged={(l) => { setView({ ...view, lifecycle: l }); load(); }} />
          {hasStages && (
            <div className="rounded-card bg-surface-1 border border-border p-4">
              <p className="text-sm font-medium text-text-primary mb-3">Timeline</p>
              <Timeline vertical={v} lifecycle={lifecycle!} stages={e.lifecycle} />
            </div>
          )}
        </div>
      )}

      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Details</h2>
          {hasLeftovers && (
            <button onClick={() => setLeftovers((x) => !x)} className="text-[11px] text-text-muted hover:text-text-primary">
              {leftovers ? "Hide" : "Show"} template leftovers
            </button>
          )}
        </div>
        <DetailsGrid entity={e} row={row} vertical={v} showLeftovers={leftovers} />
      </section>

      {related.map((r) => {
        const re = entity(r.entity)!;
        const reTitle = re.columns.find((c) => c.name === re.title);
        return (
          <section key={`${r.entity}.${r.column}`} className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary flex items-center gap-1.5">
                <Link2 size={12} /> {r.label} for this {entitySingular(e).toLowerCase()} · {r.rows.length}
              </h2>
              {composed && (
                <button onClick={() => setAdding({ entity: r.entity, column: r.column })} className="inline-flex items-center gap-1 text-[11px] text-text-accent hover:underline">
                  <Plus size={11} /> Add {entitySingular(re).toLowerCase()}
                </button>
              )}
            </div>
            {r.rows.length === 0 && <p className="text-[13px] text-text-muted">None yet.</p>}
            {r.rows.map((x) => (
              <RowCard key={String(x[re.key])} onClick={() => navigate(`/e/${re.name}/${encodeURIComponent(String(x[re.key]))}`)}>
                <span className="font-mono text-xs text-text-secondary w-28 truncate">{String(x[re.key])}</span>
                <span className="flex-1 text-[13px] text-text-primary truncate">{show(reTitle, x[re.title], v)}</span>
                <span className="text-xs text-text-secondary truncate max-w-[40%]">{subtitle(re, x, v)}</span>
                {typeof x._state === "string" && re.lifecycle && <StatusPill tone={toneForState(x._state, re.lifecycle.order)}>{stateLabelFor(re, v, x._state)}</StatusPill>}
              </RowCard>
            ))}
          </section>
        );
      })}

      <section>
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary mb-2 flex items-center gap-1.5">
          <HistoryIcon size={12} /> Activity
        </h2>
        {activity.length === 0 && <p className="text-[13px] text-text-muted">Nothing recorded yet.</p>}
        {activity.map((a) => (
          <RowCard key={a.id}>
            <span className="text-xs text-text-muted w-24">{ago(a.at)}</span>
            <span className="flex-1 text-[13px] text-text-primary">{a.summary}</span>
            <span className="text-xs text-text-secondary">{a.by}</span>
            <StatusPill tone={a.kind === "held" ? "warning" : a.kind === "refused" || a.kind === "rejected" ? "danger" : "neutral"}>{a.kind}</StatusPill>
          </RowCard>
        ))}
      </section>

      {editing && (
        <Modal
          title={`Edit ${entitySingular(e).toLowerCase()} ${String(row[e.key])}`}
          subtitle={hasStages ? (showStagePanel ? "The stage moves through the panel above, not here." : "The stage moves through the record's actions, not here.") : e.name === primary.name ? "The stage moves through the lifecycle panel, not here." : undefined}
          onClose={() => setEditing(false)}
          wide
        >
          <RecordForm
            entity={e}
            initial={row}
            submitLabel="Save changes"
            onSaved={() => {
              setEditing(false);
              load();
            }}
          />
        </Modal>
      )}
      {adding && addingTo && (
        <Modal title={`New ${entitySingular(addingTo).toLowerCase()}`} subtitle={`For ${show(titleCol, row[e.title], v)} (${id}).`} onClose={() => setAdding(null)} wide>
          <RecordForm
            entity={addingTo}
            fixed={{ [adding.column]: id }}
            submitLabel={`Add ${entitySingular(addingTo).toLowerCase()}`}
            onSaved={() => {
              setAdding(null);
              load();
            }}
          />
        </Modal>
      )}
      {hasStages && (
        <p className="text-[11px] text-text-muted mt-6">
          Current stage: {stateLabelFor(e, v, lifecycle!.state)} · entered {ago(lifecycle!.history[lifecycle!.history.length - 1]?.at ?? new Date().toISOString())}
        </p>
      )}
    </div>
  );
}
