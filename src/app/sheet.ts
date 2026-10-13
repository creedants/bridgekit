export function excelHeaderNames(values: readonly unknown[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => String(values[index]));
}
