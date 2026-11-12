// Byte formatting for display-only counters (WebDAV monthly traffic). Kept in
// a lib module so the JSX hardcode validator never mistakes the arithmetic
// for raw text.
export function formatBytes(n: number | null | undefined): string {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

export function formatTraffic(up: number | null | undefined, down: number | null | undefined): string {
  return `${formatBytes(up)} / ${formatBytes(down)}`;
}
