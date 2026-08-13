import type { ReactNode } from "react";

/** Default-height family used by every independently sized accordion view. */
export type MarketRailViewSizing = "flex" | "fixed";

/**
 * Descriptor for one activity-bar entry / accordion panel.
 * Built-ins and future plugin contributions share this shape.
 */
export interface MarketRailViewDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Stable accordion order (lower = higher on screen). */
  readonly order: number;
  readonly sizing: MarketRailViewSizing;
  readonly defaultHeight?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  /** Compact context shown while the accordion section is collapsed. */
  readonly collapsedSummary?: ReactNode;
  readonly badge?: string | number | null;
  readonly ariaLabel?: string;
}

export interface MarketRailLayoutState {
  readonly openViewIds: readonly string[];
  /** When true, content panel is hidden but openViewIds stay selected for full restore. */
  readonly panelCollapsed: boolean;
  readonly viewHeights: Readonly<Record<string, number>>;
}

export interface MarketRailLayoutActions {
  setOpenViewIds(ids: readonly string[]): void;
  /** Activity-bar click: independently toggle a view, or reveal the panel if hidden. */
  toggleView(viewId: string): void;
  openView(viewId: string): void;
  closeView(viewId: string): void;
  setPanelCollapsed(collapsed: boolean): void;
  togglePanelCollapsed(): void;
  setViewHeight(viewId: string, height: number): void;
  isOpen(viewId: string): boolean;
}
