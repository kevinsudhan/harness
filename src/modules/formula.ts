/**
 * Formulas — the one piece of logic a module is allowed to carry.
 *
 * A computed field (an invoice's balance), a guard on an action ("only while seats are
 * left"), an automatic move ("paid once the balance reaches zero") and a value an action
 * writes ("due in thirty days") are all the same thing: a small expression over a record.
 * Writing them as text rather than code is what lets a model read and edit a module, and
 * lets the composer check every name in one before anything runs — a formula naming a
 * field the entity does not have is a build error, not a NaN on a customer's invoice.
 *
 * The language, all of it:
 *
 *   numbers 12.5   strings "paid"   true false null
 *   fields  total   params param.amount   settings setting.payment_terms_days
 *   state   the record's lifecycle state
 *   refs    contact_id.full_name — follow a ref field to the row it points at
 *   + - * /   = != < <= > >=   and or not   ( )
 *   today() now() actor() id() created()   if(condition, then, else)
 *   add_days(date, n)  add_minutes(datetime, n)  days_between(a, b)
 *   coalesce(a, b, …)  round(x, digits)  min(a, b)  max(a, b)
 *   sum(child.field)  sum(child.field, condition)  count(child)  count(child, condition)
 *
 * `sum` and `count` run over the rows of another entity that point at this record —
 * `sum(invoice_line.amount)` on an invoice adds up its own lines — and their condition is
 * read against each of those rows.
 *
 * Parsed by hand, evaluated by walking the tree. There is no eval and no way to reach
 * anything but the record, its params, its settings and its children.
 */

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "path"; p: string[] }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: "-" | "not"; a: Node }
  | { k: "bin"; op: BinOp; a: Node; b: Node };

type BinOp = "+" | "-" | "*" | "/" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";

export class FormulaError extends Error {}

const FUNCTIONS: Record<string, [min: number, max: number]> = {
  today: [0, 0],
  now: [0, 0],
  actor: [0, 0],
  id: [0, 0],
  created: [0, 0],
  if: [3, 3],
  add_days: [2, 2],
  add_minutes: [2, 2],
  days_between: [2, 2],
  coalesce: [1, 8],
  round: [1, 2],
  min: [2, 2],
  max: [2, 2],
  sum: [1, 2],
  count: [1, 2],
};

export const AGGREGATES = new Set(["sum", "count"]);

// ------------------------------------------------------------------------------ parsing

type Tok = { t: "num" | "str" | "id" | "op"; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = src.slice(i).match(/^[0-9]+(\.[0-9]+)?/)!;
      out.push({ t: "num", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new FormulaError(`unclosed string at ${i}`);
      out.push({ t: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = src.slice(i).match(/^[a-z_][a-z0-9_]*/i)!;
      out.push({ t: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["!=", "<=", ">="].includes(two)) {
      out.push({ t: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if ("=<>+-*/(),.".includes(c)) {
      out.push({ t: "op", v: c, at: i });
      i++;
      continue;
    }
    throw new FormulaError(`unexpected "${c}" at ${i}`);
  }
  return out;
}

const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

export function parse(src: string): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const isWord = (v: string) => peek()?.t === "id" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`expected "${v}" ${peek() ? `at ${peek()!.at}` : "at the end"} in: ${src}`);
    pos++;
  };

  const or = (): Node => {
    let a = and();
    while (isWord("or")) { pos++; a = { k: "bin", op: "or", a, b: and() }; }
    return a;
  };
  const and = (): Node => {
    let a = not();
    while (isWord("and")) { pos++; a = { k: "bin", op: "and", a, b: not() }; }
    return a;
  };
  const not = (): Node => {
    if (isWord("not")) { pos++; return { k: "un", op: "not", a: not() }; }
    return cmp();
  };
  const cmp = (): Node => {
    const a = add();
    const t = peek();
    if (t?.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      pos++;
      return { k: "bin", op: t.v as BinOp, a, b: add() };
    }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (isOp("+") || isOp("-")) { const op = toks[pos++].v as BinOp; a = { k: "bin", op, a, b: mul() }; }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (isOp("*") || isOp("/")) { const op = toks[pos++].v as BinOp; a = { k: "bin", op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-")) { pos++; return { k: "un", op: "-", a: unary() }; }
    return primary();
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new FormulaError(`unexpected end of: ${src}`);
    if (t.t === "num") { pos++; return { k: "num", v: Number(t.v) }; }
    if (t.t === "str") { pos++; return { k: "str", v: t.v }; }
    if (isOp("(")) { pos++; const e = or(); expect(")"); return e; }
    if (t.t === "id") {
      pos++;
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
      if (t.v === "null") return { k: "null" };
      if (KEYWORDS.has(t.v)) throw new FormulaError(`"${t.v}" cannot start a value, at ${t.at}`);
      if (isOp("(")) {
        pos++;
        const arity = FUNCTIONS[t.v];
        if (!arity) throw new FormulaError(`no function "${t.v}" (have: ${Object.keys(FUNCTIONS).join(", ")})`);
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(or());
          while (isOp(",")) { pos++; args.push(or()); }
        }
        expect(")");
        if (args.length < arity[0] || args.length > arity[1]) {
          throw new FormulaError(`${t.v}() takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument(s), got ${args.length}`);
        }
        if (AGGREGATES.has(t.v) && args[0].k !== "path") throw new FormulaError(`${t.v}() needs an entity first, like ${t.v}(invoice_line${t.v === "sum" ? ".amount" : ""})`);
        return { k: "call", name: t.v, args };
      }
      const p = [t.v];
      while (isOp(".")) {
        pos++;
        const n = peek();
        if (n?.t !== "id") throw new FormulaError(`expected a name after "." in: ${src}`);
        p.push(n.v);
        pos++;
      }
      return { k: "path", p };
    }
    throw new FormulaError(`unexpected "${t.v}" at ${t.at} in: ${src}`);
  };

  const node = or();
  if (pos < toks.length) throw new FormulaError(`unexpected "${toks[pos].v}" at ${toks[pos].at} in: ${src}`);
  return node;
}

// --------------------------------------------------------------------------- references

/** A name a formula reads, so the composer can check it exists. */
export type Reference =
  | { kind: "path"; path: string[] }
  /** sum(child.field, cond) / count(child, cond): field is null for count; inner refs are read on the child. */
  | { kind: "aggregate"; entity: string; field: string | null; inner: Reference[] };

export function references(node: Node): Reference[] {
  const out: Reference[] = [];
  const walk = (n: Node, into: Reference[]) => {
    switch (n.k) {
      case "path":
        into.push({ kind: "path", path: n.p });
        return;
      case "un":
        walk(n.a, into);
        return;
      case "bin":
        walk(n.a, into);
        walk(n.b, into);
        return;
      case "call":
        if (AGGREGATES.has(n.name)) {
          const target = (n.args[0] as { p: string[] }).p;
          const inner: Reference[] = [];
          if (n.args[1]) walk(n.args[1], inner);
          into.push({ kind: "aggregate", entity: target[0], field: target.slice(1).join(".") || null, inner });
          return;
        }
        for (const a of n.args) walk(a, into);
        return;
      default:
        return;
    }
  };
  walk(node, out);
  return out;
}

// ---------------------------------------------------------------------------- evaluation

export interface Scope {
  /** A field; `param.x`; `setting.x`; `state`; or a ref followed, `contact_id.full_name`. */
  get(path: string[]): unknown;
  /** The rows of `entity` that point at this record, each as a scope of its own. */
  children(entity: string): Scope[];
  today(): string;
  now(): string;
  actor(): string;
  id(): string;
  /** The id of the row an action just created, for writing a link back to it. */
  created(): string | null;
}

const blank = (x: unknown) => x === null || x === undefined || x === "";

function num(x: unknown, what: string): number {
  if (blank(x)) return 0;
  if (typeof x === "boolean") return x ? 1 : 0;
  const n = typeof x === "number" ? x : Number(String(x).replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new FormulaError(`${what} is not a number (${JSON.stringify(x)})`);
  return n;
}

const numeric = (x: unknown) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)));

export function truthy(x: unknown): boolean {
  return !(blank(x) || x === false || x === 0);
}

function equal(a: unknown, b: unknown): boolean {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (numeric(a) && numeric(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}

function order(a: unknown, b: unknown): number | null {
  if (blank(a) || blank(b)) return null;
  if (numeric(a) && numeric(b)) return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function addDays(d: unknown, n: number): string | null {
  if (blank(d)) return null;
  const s = String(d);
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new FormulaError(`${JSON.stringify(d)} is not a date`);
  const out = new Date(t + n * 86_400_000).toISOString();
  return s.length === 10 ? out.slice(0, 10) : out;
}

export function evaluate(node: Node, scope: Scope): unknown {
  switch (node.k) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "null":
      return null;
    case "path":
      return scope.get(node.p);
    case "un": {
      const a = evaluate(node.a, scope);
      return node.op === "not" ? !truthy(a) : -num(a, "the value after -");
    }
    case "bin": {
      if (node.op === "and") return truthy(evaluate(node.a, scope)) && truthy(evaluate(node.b, scope));
      if (node.op === "or") return truthy(evaluate(node.a, scope)) || truthy(evaluate(node.b, scope));
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      switch (node.op) {
        case "=": return equal(a, b);
        case "!=": return !equal(a, b);
        case "<": { const o = order(a, b); return o !== null && o < 0; }
        case "<=": { const o = order(a, b); return o !== null && o <= 0; }
        case ">": { const o = order(a, b); return o !== null && o > 0; }
        case ">=": { const o = order(a, b); return o !== null && o >= 0; }
        case "+":
          // Text joins, numbers add — "Call back " + contact_id.full_name.
          if ((typeof a === "string" && !numeric(a) && !blank(a)) || (typeof b === "string" && !numeric(b) && !blank(b))) {
            return `${blank(a) ? "" : String(a)}${blank(b) ? "" : String(b)}`;
          }
          return num(a, "left of +") + num(b, "right of +");
        case "-": return num(a, "left of -") - num(b, "right of -");
        case "*": return num(a, "left of *") * num(b, "right of *");
        case "/": {
          const d = num(b, "right of /");
          return d === 0 ? null : num(a, "left of /") / d;
        }
      }
      return null;
    }
    case "call":
      return call(node, scope);
  }
}

function call(node: Extract<Node, { k: "call" }>, scope: Scope): unknown {
  const arg = (i: number) => evaluate(node.args[i], scope);
  switch (node.name) {
    case "today": return scope.today();
    case "now": return scope.now();
    case "actor": return scope.actor();
    case "id": return scope.id();
    case "created": return scope.created();
    case "if": return truthy(arg(0)) ? arg(1) : arg(2);
    case "add_days": return addDays(arg(0), num(arg(1), "add_days' day count"));
    case "add_minutes": {
      const d = arg(0);
      if (blank(d)) return null;
      const t = Date.parse(String(d));
      if (Number.isNaN(t)) throw new FormulaError(`${JSON.stringify(d)} is not a date and time`);
      return new Date(t + num(arg(1), "add_minutes' minute count") * 60_000).toISOString();
    }
    case "days_between": {
      const a = arg(0);
      const b = arg(1);
      if (blank(a) || blank(b)) return null;
      const ta = Date.parse(String(a).length === 10 ? `${a}T00:00:00Z` : String(a));
      const tb = Date.parse(String(b).length === 10 ? `${b}T00:00:00Z` : String(b));
      if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
      return Math.round((tb - ta) / 86_400_000);
    }
    case "coalesce":
      for (const a of node.args) {
        const v = evaluate(a, scope);
        if (!blank(v)) return v;
      }
      return null;
    case "round": {
      const v = arg(0);
      if (blank(v)) return null;
      const f = 10 ** (node.args[1] ? num(arg(1), "round's digits") : 0);
      return Math.round(num(v, "round's value") * f) / f;
    }
    case "min": return Math.min(num(arg(0), "min"), num(arg(1), "min"));
    case "max": return Math.max(num(arg(0), "max"), num(arg(1), "max"));
    case "sum":
    case "count": {
      const [entity, ...field] = (node.args[0] as { p: string[] }).p;
      const rows = scope.children(entity).filter((c) => !node.args[1] || truthy(evaluate(node.args[1], c)));
      if (node.name === "count") return rows.length;
      return rows.reduce((s, c) => s + num(c.get(field), `${entity}.${field.join(".")}`), 0);
    }
  }
  throw new FormulaError(`no function "${node.name}"`);
}

/** Parses once per source string — module formulas are evaluated on every write. */
const CACHE = new Map<string, Node>();
export function compiled(src: string): Node {
  let n = CACHE.get(src);
  if (!n) {
    n = parse(src);
    CACHE.set(src, n);
  }
  return n;
}

export function run(src: string, scope: Scope): unknown {
  return evaluate(compiled(src), scope);
}

/** A written value: "=formula" is evaluated, anything else is the value itself. */
export function valueOf(v: string | number | boolean | null, scope: Scope): unknown {
  return typeof v === "string" && v.startsWith("=") ? run(v.slice(1), scope) : v;
}
