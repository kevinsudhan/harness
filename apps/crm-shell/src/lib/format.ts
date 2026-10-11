import type { Column, Entity, Param, Row, Vertical } from "./api";

/** An action's input as a column, so the record form's fields can render it. */
export function paramColumn(p: Param): Column {
  const storage: Record<string, string> = {
    money: "numeric", number: "numeric", percent: "numeric", integer: "integer", boolean: "boolean",
    date: "date", datetime: "timestamp with time zone", tags: "text[]", json: "jsonb",
  };
  return { name: p.name, type: storage[p.type] ?? "text", semantic: p.type, label: p.label, options: p.options, links: p.ref, required: p.required, help: p.help };
}

export const humanize = (s: string) => {
  const t = s.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "appointments" → "appointment", for buttons like "New appointment". */
export const singular = (label: string) => label.replace(/ies$/i, "y").replace(/([^s])s$/i, "$1");

export const stateLabel = (v: Vertical, state: string | null | undefined) =>
  state ? v.lifecycle.states[state]?.label ?? humanize(state) : "—";

/** A state of any entity: its own stages in a composed app, the vertical's otherwise. */
export const stateLabelFor = (e: Entity | undefined, v: Vertical, state: string | null | undefined) =>
  state ? e?.lifecycle?.states[state]?.label ?? stateLabel(v, state) : "—";

/** The order of an entity's stages, or null when it has none. */
export const stagesOf = (e: Entity | undefined, v: Vertical, isPrimary: boolean): string[] | null =>
  e?.lifecycle?.order ?? (isPrimary ? v.lifecycle.order : null);

/** A column's name as the business says it. */
export const colLabel = (c: Column) => c.label ?? humanize(c.name);

/** "Patient" for a composed entity that says so; "appointments" → "appointment" otherwise. */
export const entitySingular = (e: Entity) => e.singular ?? singular(e.label);

/** What a link points at, by name when the server sent it. */
export const linkLabel = (r: Row, c: Column) => (r._labels as Record<string, string> | undefined)?.[c.name] ?? String(r[c.name]);

export function money(v: Vertical, n: number) {
  return `${v.business.currencySymbol}${n.toLocaleString(v.business.locale)}`;
}

/** A cell, formatted for its column type. */
export function show(col: Column | undefined, v: unknown, vertical?: Vertical): string {
  if (v === null || v === undefined || v === "") return "—";
  if (!col) return String(v);
  if (col.type === "boolean") return v ? "Yes" : "No";
  if (col.type === "timestamp with time zone") {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(vertical?.business.locale, { dateStyle: "medium", timeStyle: "short" });
  }
  if (col.type === "date") {
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(vertical?.business.locale, { dateStyle: "medium" });
  }
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (vertical && col.semantic === "money") return money(vertical, Number(v));
  if (col.semantic === "percent") return `${v}%`;
  if (col.semantic === "choice") return humanize(String(v));
  if (vertical && !col.semantic && (col.type === "numeric" || col.type === "integer") && /(fee|amount|cost|price|rate)/.test(col.name)) return money(vertical, Number(v));
  return String(v);
}

/** Columns worth showing: not the freight leftovers, not bookkeeping, not the stage (it has its own pill). */
export function visibleColumns(e: Entity, opts: { includeLeftovers?: boolean } = {}): Column[] {
  return e.columns.filter((c) => (opts.includeLeftovers || !c.leftover) && !["created_at", "updated_at"].includes(c.name) && c.name !== e.stageColumn);
}

/** Columns a person fills in when creating a row: not computed ones, not the generated reference. */
export function formColumns(e: Entity, stageColumn: string | null): Column[] {
  return visibleColumns(e).filter((c) => {
    if (c.name === stageColumn) return false;
    if (c.formula) return false;
    if (c.pk && (c.type === "uuid" || c.type === "bigint" || c.type === "integer")) return false;
    if (c.pk) return false; // readable references are generated: APT-0001
    if (c.type === "jsonb") return false;
    return true;
  });
}

export function subtitle(e: Entity, r: Row, vertical: Vertical): string {
  // Links read as names when the server sent them (composed apps); otherwise they are skipped.
  const named = !!r._labels;
  const bits = visibleColumns(e)
    .filter((c) => c.name !== e.title && c.name !== e.key && (!c.links || named) && r[c.name] != null && r[c.name] !== "" && c.type !== "jsonb" && c.semantic !== "longtext")
    .slice(0, 3)
    .map((c) => (c.links ? linkLabel(r, c) : show(c, r[c.name], vertical)));
  return bits.join(" · ");
}

export function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
