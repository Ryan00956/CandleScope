import type { ChartCellId } from "./chartWorkspaceTypes.js";

export interface MultiChartCellRenderCounts {
  cellId: ChartCellId;
  reactRenders: number;
  domCommits: number;
}

export interface MultiChartRenderSnapshot {
  cells: MultiChartCellRenderCounts[];
  totalReactRenders: number;
  totalDomCommits: number;
}

export class MultiChartRenderDiagnostics {
  private readonly cells = new Map<ChartCellId, MultiChartCellRenderCounts>();

  recordRender(cellId: ChartCellId): void {
    this.counts(cellId).reactRenders += 1;
  }

  recordCommit(cellId: ChartCellId): void {
    this.counts(cellId).domCommits += 1;
  }

  reset(): void {
    this.cells.clear();
  }

  snapshot(): MultiChartRenderSnapshot {
    const cells = [...this.cells.values()]
      .map((value) => ({ ...value }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId));
    return {
      cells,
      totalReactRenders: cells.reduce((total, cell) => total + cell.reactRenders, 0),
      totalDomCommits: cells.reduce((total, cell) => total + cell.domCommits, 0),
    };
  }

  private counts(cellId: ChartCellId): MultiChartCellRenderCounts {
    const current = this.cells.get(cellId);
    if (current) return current;
    const created = { cellId, reactRenders: 0, domCommits: 0 };
    this.cells.set(cellId, created);
    return created;
  }
}

declare global {
  interface Window {
    __CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__?: MultiChartRenderDiagnostics;
  }
}

function activeDiagnostics(): MultiChartRenderDiagnostics | null {
  if (typeof window === "undefined") return null;
  const target = window as Window & {
    __CANDLESCOPE_MULTI_CHART_CAPACITY__?: unknown;
  };
  if (target.__CANDLESCOPE_MULTI_CHART_CAPACITY__ === undefined) return null;
  if (!target.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__) {
    target.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__ = new MultiChartRenderDiagnostics();
  }
  return target.__CANDLESCOPE_MULTI_CHART_RENDER_DIAGNOSTICS__;
}

export function recordMultiChartCellRender(cellId: ChartCellId): void {
  activeDiagnostics()?.recordRender(cellId);
}

export function recordMultiChartCellCommit(cellId: ChartCellId): void {
  activeDiagnostics()?.recordCommit(cellId);
}
