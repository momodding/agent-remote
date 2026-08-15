// Pure cell-math mirror of the inline touch-selection logic injected into
// terminal_html.ts (that copy must stay a self-contained JS string for the
// WebView, so it can't import this module — keep the two in sync by hand).
export type Rect = { left: number; top: number; width: number; height: number };

export function touchToCell(x: number, y: number, rect: Rect, cols: number, rows: number): { col: number; row: number } {
  const col = Math.max(0, Math.min(cols - 1, Math.floor(((x - rect.left) / rect.width) * cols)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(((y - rect.top) / rect.height) * rows)));
  return { col, row };
}

// Linear length spanning start -> end across (possibly multiple) terminal rows.
export function selectionLength(startCol: number, startRow: number, endCol: number, endRow: number, cols: number): number {
  const startRowMin = Math.min(startRow, endRow);
  const endRowMax = Math.max(startRow, endRow);
  const lo = startRow < endRow ? startCol : startRow > endRow ? endCol : Math.min(startCol, endCol);
  const hi = startRow < endRow ? endCol : startRow > endRow ? startCol : Math.max(startCol, endCol);
  return Math.max(1, (endRowMax - startRowMin) * cols + (hi - lo) + 1);
}
