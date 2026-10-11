/**
 * Sample data for a composed app, so a fresh build is not an empty screen.
 *
 * The template's seeder guessed from column names, because a cloned column's name was all
 * it had. A module's field says what it is — money, a phone number, a choice and its
 * options, a link to what — so values come from that, and every row is a valid row: it
 * goes through the engine like a person's would, links to rows that exist, and gets its
 * computed fields worked out. Only into an empty app, only on request, always labelled.
 */
import type { AppColumn, AppEntity, AppManifest } from "../builder/appManifest.js";
import type { ModuleEngine } from "./engine.js";
import type { Row } from "../app-runtime/store.js";
import { EngineError } from "../app-runtime/engine.js";

const PEOPLE = ["Priya Raman", "Arjun Mehta", "Lakshmi Iyer", "Karthik Rao", "Divya Nair", "Rahul Sharma", "Meena Krishnan", "Vikram Singh", "Ananya Das", "Suresh Kumar"];
const ORGS = ["Apex Traders", "Sunrise Foods", "Metro Logistics", "Coastal Textiles", "Lotus Pharma", "Bluewave Tech"];

function day(offset: number, hour = 10, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function value(e: AppEntity, c: AppColumn, i: number): unknown {
  const n = c.name;
  const t = c.semantic ?? "text";
  if (c.pk || c.formula || c.links || n === e.stageColumn || n === "created_at" || n === "updated_at") return undefined;
  switch (t) {
    case "phone": return `+91 98${String(41000000 + i * 1234567).slice(0, 8)}`;
    case "email": return `sample${i + 1}@example.com`;
    case "url": return undefined;
    case "boolean": return n === "active" ? true : n === "do_not_contact" || n === "credit_hold" ? false : undefined;
    case "choice": return c.options?.length ? c.options[i % c.options.length] : undefined;
    case "tags": return [];
    case "json": return undefined;
    case "percent": return /tax/.test(n) ? [0, 5, 18][i % 3] : /discount/.test(n) ? 0 : 10;
    case "money": return /price|rate|amount|fee|budget|value/.test(n) ? 500 + ((i * 1370) % 9000) : undefined;
    case "integer":
      if (/capacity/.test(n)) return 12;
      if (/minutes/.test(n)) return [30, 45, 60][i % 3];
      if (/days/.test(n)) return 30;
      if (/seats/.test(n)) return 1;
      if (/rating/.test(n)) return 4 + (i % 2);
      return c.required ? 1 + (i % 3) : undefined;
    case "number": return /hours/.test(n) ? 1 + (i % 4) : /quantity/.test(n) ? 1 + (i % 3) : /reorder/.test(n) ? 5 : c.required ? 1 : undefined;
    case "date":
      if (/birth|born/.test(n)) return `19${80 + (i % 15)}-0${1 + (i % 9)}-1${i % 9}`;
      return c.required || /due|until|ends|expires|next/.test(n) ? day(7 + i * 3).toISOString().slice(0, 10) : undefined;
    case "datetime": return c.required ? day(1 + i, 9 + (i % 8), i % 2 ? 30 : 0).toISOString() : undefined;
    case "longtext": return c.required || /notes|details|description/.test(n) ? "Sample — replace or delete." : undefined;
    default:
      if (n === "full_name") return PEOPLE[i % PEOPLE.length];
      if (n === e.title || c.required) {
        if (e.name === "account" || e.name === "supplier") return ORGS[i % ORGS.length];
        return `Sample ${(e.singular ?? e.label).toLowerCase()} ${i + 1}`;
      }
      return undefined;
  }
}

/** Entities whose links point at entities already seeded go first. */
function order(app: AppManifest): AppEntity[] {
  const left = [...app.entities];
  const done: AppEntity[] = [];
  while (left.length) {
    const i = left.findIndex((e) => e.columns.every((c) => !c.links || c.links === e.name || !left.some((x) => x.name === c.links) || !c.required));
    const [next] = left.splice(i < 0 ? 0 : i, 1);
    done.push(next);
  }
  // Optional links still want targets: put entities nothing points at last.
  return done;
}

export function seedComposed(app: AppManifest, engine: ModuleEngine, by: string): { created: Record<string, number>; skipped: Record<string, string> } {
  if (engine.store.rows(engine.primary).length) throw new EngineError("the app already has records — sample data only goes into an empty app");
  const created: Record<string, number> = {};
  const skipped: Record<string, string> = {};
  const ids = new Map<string, string[]>();

  for (const e of order(app)) {
    // A log fills itself from real activity; inventing calls and messages would read as real.
    if (["call", "message", "stock_movement", "payment", "time_entry", "feedback", "consent_record", "document", "commitment"].includes(e.name)) continue;
    const isLine = e.name.endsWith("_line");
    const parentLink = isLine ? e.columns.find((c) => c.links && c.required) : undefined;
    const count = e.name === engine.primary.name ? Math.max((e.lifecycle?.order.length ?? 4) + 2, 6) : isLine ? 2 * (ids.get(parentLink?.links ?? "")?.length ?? 0) : 3;
    for (let i = 0; i < count; i++) {
      const row: Row = {};
      for (const c of e.columns) {
        let v = value(e, c, i);
        if (c.links) {
          const pool = ids.get(c.links) ?? [];
          v = pool.length ? pool[(isLine && c === parentLink ? Math.floor(i / 2) : i) % pool.length] : undefined;
        }
        if (v !== undefined) row[c.name] = v;
      }
      // One booking per resource per day: spread them so the no-overlap rule has nothing to refuse.
      if (e.noOverlap && row[e.noOverlap.start]) row[e.noOverlap.start] = day(1 + i, 9 + (i % 6)).toISOString();
      try {
        const saved = engine.create(e.name, row, by);
        ids.set(e.name, [...(ids.get(e.name) ?? []), String(saved.id)]);
        created[e.name] = (created[e.name] ?? 0) + 1;
        if (e.name === engine.primary.name && e.lifecycle) {
          const states = e.lifecycle.order;
          engine.placeSample(e.name, String(saved.id), states[i % states.length]);
        }
      } catch (err) {
        skipped[e.name] = err instanceof Error ? err.message : String(err);
      }
    }
  }
  engine.note(`sample data loaded: ${Object.entries(created).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}`, by);
  return { created, skipped };
}
