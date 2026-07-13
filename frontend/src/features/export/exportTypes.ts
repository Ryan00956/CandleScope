import type { ExportFormat } from "../../utils/exportFilename.js";

export type ExportScope = "chart" | "main-pane" | "page";

export interface ExportMetadata {
  exchange?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
  theme?: string;
}

export interface ExportOptions {
  scope: ExportScope;
  format: ExportFormat;
  scale: number;
  quality: number;
  backgroundColor: string;
  hideDrawings: boolean;
  watermarkEnabled: boolean;
  watermarkText: string;
  filenamePrefix: string;
  filename?: string;
  metadata?: ExportMetadata;
  pageElement?: HTMLElement | null;
}

export interface ExportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportSnapshot {
  rootElement?: HTMLElement | null;
  mainPane?: {
    rootElement?: HTMLElement | null;
    captureRect?: ExportRect | null;
  } | null;
}

export interface CanvasCropPlan {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ExportImageResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  mimeType: string;
  optionsKey: string;
}
