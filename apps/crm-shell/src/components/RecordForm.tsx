import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type Column, type Entity, type Row } from "../lib/api";
import { useApp } from "../lib/app";
import { colLabel, formColumns, show } from "../lib/format";

/**
 * A form generated from a table's columns — the inputs follow the column types, and a
 * column that points at another table becomes a picker over that table's rows. Used to
 * create a row and to edit one; the server re-checks every value against the schema.
 *
 * In a composed app a column also says what it is: a choice becomes a dropdown of its
 * options, a required field is marked, a computed one (a total, a balance) is not asked
 * for at all. `fixed` presets fields and hides them — an invoice line added from its
 * invoice already knows which invoice it is on.
 */
export default function RecordForm({
  entity,
  initial,
  fixed,
  onSaved,
  submitLabel,
}: {
  entity: Entity;
  initial?: Row;
  fixed?: Row;
  onSaved: (row: Row) => void;
  submitLabel: string;
}) {
  const { info, touch } = useApp();
  const stageColumn = entity.stageColumn ?? (info.manifest.primary.entity === entity.name ? info.manifest.primary.stageColumn : null);
  const cols = formColumns(entity, stageColumn).filter((c) => !(fixed && c.name in fixed));
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(cols.map((c) => [c.name, toInput(c, initial?.[c.name])])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Only send what changed on an edit, so a save never rewrites fields nobody touched.
      const payload: Row = { ...(fixed ?? {}) };
      for (const c of cols) {
        const v = values[c.name];
        const before = toInput(c, initial?.[c.name]);
        if (initial && v === before) continue;
        payload[c.name] = v === "" ? null : c.type === "timestamp with time zone" && typeof v === "string" ? new Date(v).toISOString() : v;
      }
      const row = initial
        ? await api.update(entity.name, String(initial[entity.key]), payload)
        : await api.create(entity.name, payload);
      touch();
      onSaved(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {cols.map((c) => (
          <Field key={c.name} col={c} value={values[c.name]} onChange={(v) => setValues((s) => ({ ...s, [c.name]: v }))} />
        ))}
      </div>
      {error && (
        <p className="text-[12px] text-text-danger flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand text-white text-[13px] font-medium px-4 py-2 hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export function toInput(c: Column, v: unknown): string | boolean {
  if (c.type === "boolean") return v === true;
  if (v === null || v === undefined) return "";
  if (c.type === "timestamp with time zone") {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

const isWide = (c: Column) => c.semantic === "longtext" || (!c.semantic && c.type === "text" && /(notes?|description|details|summary|transcript)$/.test(c.name));

export function Field({ col, value, onChange }: { col: Column; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const label = colLabel(col);
  const wide = isWide(col);

  if (col.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-[13px] text-text-primary sm:col-span-1 pt-5">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="w-auto" />
        {label}
      </label>
    );
  }

  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className="block text-[11px] uppercase tracking-wide text-text-muted mb-1">
        {label}
        {col.required && <span className="text-text-danger"> *</span>}
      </span>
      {col.links ? (
        <LinkPicker target={col.links} value={String(value)} onChange={onChange} />
      ) : col.options?.length ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)} className="w-full">
          <option value="">—</option>
          {col.options.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      ) : wide ? (
        <textarea rows={3} value={String(value)} onChange={(e) => onChange(e.target.value)} className="w-full" />
      ) : (
        <input
          type={inputType(col)}
          step={col.type === "numeric" ? "any" : undefined}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={col.type === "text[]" ? "comma, separated" : undefined}
          className="w-full"
        />
      )}
      {col.help && <span className="block text-[11px] text-text-muted mt-1">{col.help}</span>}
    </label>
  );
}

function inputType(c: Column): string {
  if (c.type === "date") return "date";
  if (c.type === "timestamp with time zone") return "datetime-local";
  if (c.type === "integer" || c.type === "bigint" || c.type === "numeric") return "number";
  if (c.semantic === "email" || (/email/.test(c.name) && c.type === "text")) return "email";
  if (c.semantic === "phone" || (/phone/.test(c.name) && c.type === "text")) return "tel";
  if (c.semantic === "url") return "url";
  return "text";
}

/** A column pointing at another table picks from that table's rows, by their titles. */
function LinkPicker({ target, value, onChange }: { target: string; value: string; onChange: (v: string) => void }) {
  const { entity, info } = useApp();
  const e = entity(target);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (e) api.rows(e.name).then(setRows).catch(() => setRows([]));
  }, [e]);
  if (!e) return <input value={value} onChange={(ev) => onChange(ev.target.value)} className="w-full" />;
  const titleCol = e.columns.find((c) => c.name === e.title);
  return (
    <select value={value} onChange={(ev) => onChange(ev.target.value)} className="w-full">
      <option value="">—</option>
      {rows.map((r) => (
        <option key={String(r[e.key])} value={String(r[e.key])}>
          {show(titleCol, r[e.title], info.manifest.vertical)} · {String(r[e.key])}
        </option>
      ))}
    </select>
  );
}
