import type { ReactNode } from "react";

/** How a stacked rail view consumes vertical space. */
export type MarketRailViewSizing = "flex" | "fixed";

/**
 * Descriptor for one activity-bar entry / stackable panel.
 * Built-ins and future plugin contributions share this shape.
 */
export interface MarketRailViewDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  /** Stable stack order (lower = higher on screen). */
  readonly order: number;
  readonly sizing: MarketRailViewSizing;
  readonly defaultHeight?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly badge?: string | number | null;
  readonly ariaLabel?: string;
}

export interface MarketRailLayoutState {
  readonly openViewIds: readonly string[];
  readonly viewHeights: Readonly<Record<string, number>>;
}

export interface MarketRailLayoutActions {
  setOpenViewIds(ids: readonly string[]): void;
  toggleView(viewId: string): void;
  openView(viewId: string): void;
  closeView(viewId: string): void;
  setViewHeight(viewId: string, height: number): void;
  isOpen(viewId: string): boolean;
}
