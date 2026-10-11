/**
 * Reading a model's JSON when it is almost JSON.
 *
 * Measured on a live draft ("a law firm CRM"): the model wrote a whole module on one line
 * and closed it with `}}}}},` — one brace too many. The answer was otherwise right, and the
 * repair call, shown the broken text, made the same slip again; both calls were spent on a
 * bracket. The builder's rule is that a slip with one right answer is fixed in code at zero
 * tokens rather than explained to a model, and this is that kind of slip.
 *
 * What is repaired, outside strings only:
 *   - comments (`//`, `/* *\/`) and trailing commas before a closing bracket,
 *   - a closing bracket with nothing of its kind to close — dropped, or read as the
 *     brackets the model forgot to write before it (whichever gives valid JSON),
 *   - brackets still open at the end — closed.
 *
 * Every repair is reported, so a person can see what was changed. The result is still only
 * a parse: zod and compose() check every field after it, so a repair that guessed a
 * structure wrongly is caught there, by name.
 */

type Strategy = "drop" | "close";

function repair(src: string, strategy: Strategy): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  const stack: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  let line = 1;

  /** A trailing comma before a closer is the commonest slip of all. */
  const dropTrailingComma = () => {
    const m = out.match(/,(\s*)$/);
    if (m) {
      out = out.slice(0, out.length - m[0].length) + m[1];
      fixes.push(`line ${line}: removed a trailing comma`);
    }
  };
  const closerOf = (open: string) => (open === "{" ? "}" : "]");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") line++;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
      fixes.push(`line ${line}: removed a comment`);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const skipped = src.slice(i, end < 0 ? src.length : end + 2);
      line += (skipped.match(/\n/g) ?? []).length;
      i = end < 0 ? src.length : end + 1;
      fixes.push(`removed a comment`);
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const want = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] === want) {
        dropTrailingComma();
        stack.pop();
        out += ch;
        continue;
      }
      const deeper = stack.lastIndexOf(want);
      if (strategy === "close" && deeper >= 0) {
        // The model skipped closers: write the ones it left out, then this one.
        while (stack.length - 1 > deeper) {
          dropTrailingComma();
          out += closerOf(stack.pop()!);
          fixes.push(`line ${line}: added a missing '${out[out.length - 1]}'`);
        }
        dropTrailingComma();
        stack.pop();
        out += ch;
        continue;
      }
      fixes.push(`line ${line}: removed a '${ch}' with nothing to close`);
      continue;
    }
    out += ch;
  }
  while (stack.length) {
    dropTrailingComma();
    out += closerOf(stack.pop()!);
    fixes.push(`added a missing '${out[out.length - 1]}' at the end`);
  }
  return { text: out, fixes };
}

/** The JSON object in a model's answer, repaired if it has to be. Throws the original error when nothing works. */
export function parseLenient(text: string): { value: unknown; fixes: string[] } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = t.indexOf("{");
  const candidates = [t, start >= 0 ? t.slice(start, t.lastIndexOf("}") + 1) : t, start >= 0 ? t.slice(start) : t].filter(Boolean);
  let first: unknown = null;
  for (const c of candidates) {
    try {
      return { value: JSON.parse(c), fixes: [] };
    } catch (e) {
      first ??= e;
    }
  }
  const body = start >= 0 ? t.slice(start) : t;
  // A stray closer reads two ways — one too many, or the model skipped some before it — and
  // both can parse, to different structures. The reading that needed fewer changes wins:
  // `}}}}},` inside a list is one brace too many (one fix), `{"id": "x"]` is a forgotten `}`.
  let best: { value: unknown; fixes: string[] } | null = null;
  for (const strategy of ["drop", "close"] as const) {
    const r = repair(body, strategy);
    // Prose after the object is not part of it: stop where the top-level object closes.
    for (const text of [r.text, trimAfterTopLevel(r.text)]) {
      try {
        const value = JSON.parse(text);
        if (!best || r.fixes.length < best.fixes.length) best = { value, fixes: r.fixes };
        break;
      } catch { /* try the next */ }
    }
  }
  if (best) return best;
  throw first instanceof Error ? first : new Error("not JSON");
}

function trimAfterTopLevel(text: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return text;
}
