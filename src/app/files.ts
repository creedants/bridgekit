export function download(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

const escapeCsv = (value: unknown) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}

/** Tab-separated so it pastes straight into Excel cells. */
export function toTsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map((v) => (v ?? "")).join("\t")).join("\n");
}

export function toExportCsv(header: string[], rows: unknown[][]): string {
  const field = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    const prefixed = typeof value === "number" || !/^[=+\-@\t\r]/.test(text) ? text : `'${text}`;
    return /[",\r\n]/.test(prefixed) ? `"${prefixed.replaceAll('"', '""')}"` : prefixed;
  };
  return [header, ...rows].map((row) => row.map(field).join(",")).join("\n");
}

export function toExportTsv(header: string[], rows: unknown[][]): string {
  const field = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    const prefixed = typeof value === "number" || !/^[=+\-@\t\r]/.test(text) ? text : `'${text}`;
    return /[\t\r\n]/.test(prefixed) ? `"${prefixed.replaceAll('"', '""')}"` : prefixed;
  };
  return [header, ...rows].map((row) => row.map(field).join("\t")).join("\n");
}

/** Cells copied from a spreadsheet: a header row with a tab in it and at least one more line. */
export function isPastedTable(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length >= 2 && lines[0].includes("\t");
}

export interface Guard {
  /** `work` returns false, or throws, when it saved nothing; then the trigger is free again at once. */
  run(work: () => boolean | void | Promise<boolean | void>): Promise<void>;
}

/** Drops a trigger while its work runs and for a short while after it saves, so a double click saves one file. */
export function makeGuard(now: () => number = () => performance.now(), coolMs = 800): Guard {
  let running = false;
  let until = -Infinity;
  return {
    async run(work) {
      if (running || now() < until) return;
      running = true;
      try {
        if ((await work()) !== false) until = now() + coolMs;
      } finally {
        running = false;
      }
    },
  };
}

const SHORT_CELL = 40;

/** A table cell's text, cut to 39 characters and an ellipsis when it is longer than 40. */
export function shorten(text: string): string {
  if (text.length <= SHORT_CELL) return text;
  const characters = Array.from(text.slice(0, (SHORT_CELL + 1) * 2));
  return characters.length <= SHORT_CELL ? text : characters.slice(0, SHORT_CELL - 1).join("") + "…";
}

export type PlannedIncrease = "empty" | "invalid" | { value: number };

/** A planned price increase in percent, as typed: a decimal from -100 to 1000 with an optional %. */
export function parsePlannedIncrease(text: string): PlannedIncrease {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)\s*%?$/.test(trimmed)) return "invalid";
  const value = Number.parseFloat(trimmed);
  return value >= -100 && value <= 1000 ? { value } : "invalid";
}
