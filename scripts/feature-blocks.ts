/**
 * Wording for an optional feature sits between <!-- feature:NAME --> and
 * <!-- /feature:NAME --> in the pages (<!-- feature:!NAME --> for wording that
 * applies only without it) and is kept only when it applies, so the pages
 * always describe the build they ship in. A block whose markers sit on their
 * own lines is removed with those lines; an inline block leaves the text
 * around it.
 */
export function applyFeatureBlocks(html: string, enabled: Record<string, boolean>): string {
  return html.replace(
    /(^[ \t]*)?<!-- feature:(!?[a-z-]+) -->([\s\S]*?)<!-- \/feature:\2 -->(\n)?/gm,
    (_, indent: string | undefined, name: string, body: string, newline: string | undefined) => {
      const on = name.startsWith("!") ? !enabled[name.slice(1)] : Boolean(enabled[name]);
      if (body.startsWith("\n")) return on ? body.slice(1).replace(/[ \t]+$/, "") : "";
      return (indent ?? "") + (on ? body : "") + (newline ?? "");
    },
  );
}
