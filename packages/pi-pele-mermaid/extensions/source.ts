/**
 * Source normalization.
 *
 * Pele's parsers are stricter than Mermaid's about a few constructs that models emit constantly.
 * Rather than showing those diagrams as source, the small set of known recoverable cases is
 * rewritten before parsing. Everything here is a syntax fix: no label text is changed.
 */

/**
 * `xychart-beta` axis labels must be quoted when they are not bare ASCII words.
 *
 * Mermaid accepts `x-axis [janvier, février]`, Pele raises "Lexical error" on it. Quoting every label is
 * always valid, so the axis is normalized unconditionally.
 */
function quoteXychartAxes(source: string): string {
  return source.replace(
    /^(\s*(?:x-axis|y-axis)\s*\[)([\s\S]*?)(\]\s*)$/gm,
    (match, head: string, body: string, tail: string) => {
      const parts = body.split(",");
      const quoted = parts.map((part) => {
        const value = part.trim();
        if (value === "") return value;
        // Already a quoted string, or a bare number/keyword the parser accepts.
        if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value;
        if (/^-?\d+(?:\.\d+)?$/.test(value)) return value;
        return `"${value.replace(/"/g, '\\"')}"`;
      });
      return `${head}${quoted.join(", ")}${tail}`;
    },
  );
}

/**
 * `line "Series A" [...]` carries an inline name. Pele's xychart grammar reads the brackets as
 * the data and treats the quoted name as a separate, unsupported token. Dropping the name keeps
 * the series and its colors, which is far more useful than a parse failure.
 */
function dropXychartSeriesNames(source: string): string {
  return source.replace(/^(\s*(?:line|bar)\s+)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s+/gm, "$1");
}

/** Applies every known recovery for the given diagram source. */
export function normalizeSource(source: string): string {
  const head = /^\s*xychart(-beta)?\b/i.test(source);
  if (!head) return source;
  return dropXychartSeriesNames(quoteXychartAxes(source));
}
