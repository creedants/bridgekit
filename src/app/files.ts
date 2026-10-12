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
  return toCsv(header, rows);
}

export function toExportTsv(header: string[], rows: unknown[][]): string {
  return toTsv(header, rows);
}
