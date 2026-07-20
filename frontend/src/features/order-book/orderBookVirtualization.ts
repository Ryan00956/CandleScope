export interface FixedRowWindow {
  start: number;
  end: number;
  totalHeight: number;
}

export function fixedRowWindow({
  rowCount,
  rowHeight,
  viewportHeight,
  scrollTop,
  overscan = 4,
}: {
  rowCount: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}): FixedRowWindow {
  const safeCount = Number.isFinite(rowCount) ? Math.max(0, Math.floor(rowCount)) : 0;
  const safeRowHeight = Number.isFinite(rowHeight) ? Math.max(1, rowHeight) : 1;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const safeOverscan = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 0;
  const totalHeight = safeCount * safeRowHeight;
  if (safeCount === 0) return { start: 0, end: 0, totalHeight };

  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const safeScrollTop = Math.min(
    maxScrollTop,
    Math.max(0, Number.isFinite(scrollTop) ? scrollTop : maxScrollTop),
  );
  const firstVisible = Math.floor(safeScrollTop / safeRowHeight);
  const visibleCount = Math.max(1, Math.ceil(safeViewportHeight / safeRowHeight));
  const start = Math.max(0, firstVisible - safeOverscan);
  const end = Math.min(safeCount, firstVisible + visibleCount + safeOverscan);
  return { start, end, totalHeight };
}
