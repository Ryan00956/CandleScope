import type { ReactNode } from "react";
import type {
  BasicLineToolId,
  FreehandToolId,
  PassiveCursorToolId,
  PositionToolId,
  ShapeToolId,
} from "../../features/drawings/drawingTypes.js";
import type { MainChartType } from "../../shared/mainChartTypes.js";

export interface ToolbarVariant<TId extends string = string> {
  id: TId;
  label: string;
  description?: string;
  icon: ReactNode;
}

export type LineToolbarToolId = BasicLineToolId
  | "line-horizontal"
  | "line-vertical"
  | "line-cross"
  | "angle-measure";

const PenIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
);

const HighlighterIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h7" />
    <path d="M13.5 3.5l7 7-8.5 8.5H6.5l7-15.5z" />
    <path d="M12 6l6 6" />
    <path d="M6.5 19L4 21.5" opacity="0.6" />
  </svg>
);

const EraserIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H7L3 16c-.8-.8-.8-2 0-2.8L14.6 1.6c.8-.8 2-.8 2.8 0L21.8 6c.8.8.8 2 0 2.8L12 18.6" />
    <path d="M6 14l4 4" />
    <line x1="2" y1="20" x2="7" y2="20" strokeDasharray="2 2" />
  </svg>
);

const TextIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7V4h16v3" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <line x1="8" y1="20" x2="16" y2="20" />
  </svg>
);

const MouseDefaultIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" />
    <line x1="17" y1="4" x2="17" y2="8" opacity="0.65" />
    <line x1="15" y1="6" x2="19" y2="6" opacity="0.65" />
  </svg>
);

const MouseCrosshairIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4l6.6 15 1.7-6 5.7-2.3L4 4z" />
    <line x1="17" y1="3" x2="17" y2="9" />
    <line x1="14" y1="6" x2="20" y2="6" />
  </svg>
);

const CursorDotIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" opacity="0.55" />
    <circle cx="17" cy="7" r="2.4" fill="currentColor" stroke="none" />
  </svg>
);

const CursorHighlighterIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" opacity="0.5" />
    <circle cx="17" cy="7" r="4.4" fill="currentColor" stroke="none" opacity="0.28" />
    <circle cx="17" cy="7" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

const MousePlainIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3l7.5 17 2.1-7.1L21 10.2 5 3z" />
  </svg>
);

const SegmentIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="19" x2="19" y2="5" />
    <circle cx="5" cy="19" r="2" fill="currentColor" />
    <circle cx="19" cy="5" r="2" fill="currentColor" />
  </svg>
);

const RayIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="19" x2="22" y2="2" />
    <circle cx="5" cy="19" r="2" fill="currentColor" />
    <path d="M19 2l3 0l0 3" />
  </svg>
);

const InfiniteLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="23" x2="23" y2="1" />
    <path d="M1 20l0 3l3 0" />
    <path d="M21 1l3 0l0 3" />
  </svg>
);

const HorizontalLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const VerticalLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="3" x2="12" y2="21" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const CrossLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
  </svg>
);

const AngleMeasureIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16" opacity="0.55" strokeDasharray="3 3" />
    <path d="M4 20L18 6" />
    <path d="M9 20a5 5 0 0 0-1.5-3.5" />
    <text x="12.5" y="18" fontSize="5" fill="currentColor" stroke="none">deg</text>
  </svg>
);

const RectangleIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="6" width="16" height="12" rx="1.5" />
    <circle cx="4" cy="6" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="18" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const EllipseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="12" rx="8" ry="5.5" />
    <circle cx="4" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

const FibonacciIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="4" x2="20" y2="20" />
    <line x1="3" y1="9" x2="21" y2="9" opacity="0.5" />
    <line x1="3" y1="13" x2="21" y2="13" opacity="0.5" />
    <line x1="3" y1="17" x2="21" y2="17" opacity="0.5" />
    <circle cx="4" cy="4" r="2" fill="currentColor" />
    <circle cx="20" cy="20" r="2" fill="currentColor" />
  </svg>
);

const LongPositionIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="3" rx="1" fill="#26a69a" stroke="none" opacity="0.5" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#2196f3" strokeWidth="2" />
    <rect x="3" y="15" width="18" height="3" rx="1" fill="#ef5350" stroke="none" opacity="0.5" />
    <path d="M12 3l3 4h-6l3-4z" fill="#26a69a" stroke="none" />
    <path d="M12 21l3-4h-6l3 4z" fill="#ef5350" stroke="none" />
  </svg>
);

const ShortPositionIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="3" rx="1" fill="#ef5350" stroke="none" opacity="0.5" />
    <line x1="3" y1="12" x2="21" y2="12" stroke="#2196f3" strokeWidth="2" />
    <rect x="3" y="15" width="18" height="3" rx="1" fill="#26a69a" stroke="none" opacity="0.5" />
    <path d="M12 3l3 4h-6l3-4z" fill="#ef5350" stroke="none" />
    <path d="M12 21l3-4h-6l3 4z" fill="#26a69a" stroke="none" />
  </svg>
);

const MagnetIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h4v7a2 2 0 0 0 4 0V3h4v7a6 6 0 0 1-12 0V3z" />
    <line x1="6" y1="7" x2="10" y2="7" />
    <line x1="14" y1="7" x2="18" y2="7" />
  </svg>
);

const CandlestickChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="4" x2="6" y2="20" />
    <rect x="4" y="8" width="4" height="7" rx="1" fill="currentColor" stroke="none" opacity="0.75" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <rect x="10" y="6" width="4" height="10" rx="1" fill="currentColor" stroke="none" opacity="0.45" />
    <line x1="18" y1="5" x2="18" y2="19" />
    <rect x="16" y="10" width="4" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.75" />
  </svg>
);

const HollowCandlestickChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="7" y1="3" x2="7" y2="21" />
    <rect x="4.5" y="7" width="5" height="9" rx="0.8" fill="none" />
    <line x1="17" y1="4" x2="17" y2="20" />
    <rect x="14.5" y="9" width="5" height="7" rx="0.8" fill="currentColor" stroke="none" opacity="0.75" />
  </svg>
);

const HeikinAshiChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="8" x2="5" y2="20" />
    <rect x="3" y="11" width="4" height="6" rx="0.8" fill="currentColor" stroke="none" opacity="0.45" />
    <line x1="12" y1="3" x2="12" y2="18" />
    <rect x="10" y="7" width="4" height="8" rx="0.8" fill="currentColor" stroke="none" opacity="0.65" />
    <line x1="19" y1="5" x2="19" y2="16" />
    <rect x="17" y="7" width="4" height="6" rx="0.8" fill="currentColor" stroke="none" opacity="0.85" />
  </svg>
);

const RenkoChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <rect x="3" y="13" width="6" height="5" rx="0.8" fill="currentColor" opacity="0.45" />
    <rect x="9" y="8" width="6" height="5" rx="0.8" fill="currentColor" opacity="0.65" />
    <rect x="15" y="3" width="6" height="5" rx="0.8" fill="currentColor" opacity="0.85" />
  </svg>
);

const PointFigureChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="5" x2="8" y2="10" />
    <line x1="8" y1="5" x2="3" y2="10" />
    <line x1="3" y1="13" x2="8" y2="18" />
    <line x1="8" y1="13" x2="3" y2="18" />
    <circle cx="16.5" cy="8" r="3" />
    <circle cx="16.5" cy="17" r="3" />
  </svg>
);

const KagiChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19V11h6V5h6v10h4" strokeWidth="1.6" />
    <path d="M10 11V5h6" strokeWidth="3.2" />
  </svg>
);

const LineBreakChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <rect x="3" y="9" width="5" height="8" rx="0.7" fill="currentColor" opacity="0.45" />
    <rect x="9.5" y="6" width="5" height="7" rx="0.7" fill="currentColor" opacity="0.65" />
    <rect x="16" y="3" width="5" height="8" rx="0.7" fill="currentColor" opacity="0.85" />
  </svg>
);

const OhlcBarChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="7" y1="5" x2="7" y2="19" />
    <line x1="4" y1="9" x2="7" y2="9" />
    <line x1="7" y1="15" x2="10" y2="15" />
    <line x1="13" y1="3" x2="13" y2="21" />
    <line x1="10" y1="7" x2="13" y2="7" />
    <line x1="13" y1="17" x2="16" y2="17" />
    <line x1="19" y1="6" x2="19" y2="18" />
    <line x1="16" y1="12" x2="19" y2="12" />
    <line x1="19" y1="10" x2="22" y2="10" />
  </svg>
);

const HighLowChartIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="8" width="3" height="11" rx="0.6" fill="currentColor" stroke="none" opacity="0.7" />
    <rect x="10.5" y="4" width="3" height="12" rx="0.6" fill="currentColor" stroke="none" opacity="0.7" />
    <rect x="17" y="6" width="3" height="14" rx="0.6" fill="currentColor" stroke="none" opacity="0.7" />
  </svg>
);

const ChartLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3,17 8,12 12,14 17,7 21,10" />
  </svg>
);

const ChartLineWithMarkersIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3,17 8,12 12,14 17,7 21,10" />
    <circle cx="3" cy="17" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="17" cy="7" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="21" cy="10" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

const ChartStepLineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3,17 8,17 8,13 13,13 13,8 18,8 18,11 21,11" />
  </svg>
);

const ChartAreaIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 18l5-6 4 3 5-8 4 4v7H3z" fill="currentColor" stroke="none" opacity="0.22" />
    <polyline points="3,18 8,12 12,15 17,7 21,11" />
    <line x1="3" y1="18" x2="21" y2="18" opacity="0.45" />
  </svg>
);

const ChartBaselineIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" strokeDasharray="3 3" opacity="0.55" />
    <path d="M3 12l5-5 4 3 4 7 5-5" />
    <path d="M3 12l5-5 4 3v2H3z" fill="#26a69a" stroke="none" opacity="0.25" />
    <path d="M12 12l4 5 5-5v6h-9z" fill="#ef5350" stroke="none" opacity="0.22" />
  </svg>
);

const ChartHistogramIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="13" width="3" height="6" rx="0.8" fill="currentColor" stroke="none" opacity="0.5" />
    <rect x="9" y="8" width="3" height="11" rx="0.8" fill="currentColor" stroke="none" opacity="0.75" />
    <rect x="14" y="5" width="3" height="14" rx="0.8" fill="currentColor" stroke="none" opacity="0.55" />
    <rect x="19" y="10" width="3" height="9" rx="0.8" fill="currentColor" stroke="none" opacity="0.8" />
    <line x1="3" y1="20" x2="22" y2="20" opacity="0.5" />
  </svg>
);

const CURSOR_VARIANTS: ToolbarVariant<PassiveCursorToolId>[] = [
  { id: "cursor-default", label: "Default cursor", icon: MouseDefaultIcon },
  { id: "cursor-crosshair", label: "Crosshair", icon: MouseCrosshairIcon },
  { id: "cursor-dot", label: "Dot cursor", icon: CursorDotIcon },
  { id: "cursor-highlighter", label: "Highlight cursor", icon: CursorHighlighterIcon },
  { id: "cursor-plain", label: "Plain cursor", icon: MousePlainIcon },
];

const CURSOR_TOOL_IDS = new Set(CURSOR_VARIANTS.map((v) => v.id));

const FREEHAND_VARIANTS: ToolbarVariant<FreehandToolId>[] = [
  { id: "pen", label: "Pen", icon: PenIcon },
  { id: "highlighter", label: "Highlighter", icon: HighlighterIcon },
];

const FREEHAND_TOOL_IDS = new Set(FREEHAND_VARIANTS.map((v) => v.id));

const LINE_VARIANTS: ToolbarVariant<LineToolbarToolId>[] = [
  { id: "line-segment", label: "Segment", icon: SegmentIcon },
  { id: "line-ray", label: "Ray", icon: RayIcon },
  { id: "line-infinite", label: "Infinite line", icon: InfiniteLineIcon },
  { id: "line-horizontal", label: "Horizontal line", icon: HorizontalLineIcon },
  { id: "line-vertical", label: "Vertical line", icon: VerticalLineIcon },
  { id: "line-cross", label: "Cross line", icon: CrossLineIcon },
  {
    id: "angle-measure",
    label: "Angle",
    description: "Visual angle on the current scale",
    icon: AngleMeasureIcon,
  },
];

const LINE_TOOL_IDS = new Set(LINE_VARIANTS.map((v) => v.id));

const SHAPE_VARIANTS: ToolbarVariant<ShapeToolId>[] = [
  { id: "shape-rectangle", label: "Rectangle", icon: RectangleIcon },
  { id: "shape-ellipse", label: "Ellipse", icon: EllipseIcon },
];

const SHAPE_TOOL_IDS = new Set(SHAPE_VARIANTS.map((v) => v.id));

const POSITION_VARIANTS: ToolbarVariant<PositionToolId>[] = [
  { id: "position-long", label: "Long position", icon: LongPositionIcon },
  { id: "position-short", label: "Short position", icon: ShortPositionIcon },
];

const POSITION_TOOL_IDS = new Set(POSITION_VARIANTS.map((v) => v.id));

const CHART_TYPE_VARIANTS: ToolbarVariant<MainChartType>[] = [
  { id: "candlestick", label: "Candles", description: "Open, high, low and close candles", icon: CandlestickChartIcon },
  { id: "hollow-candlestick", label: "Hollow candles", description: "Body fill and price-change color", icon: HollowCandlestickChartIcon },
  { id: "heikin-ashi", label: "Heikin Ashi", description: "Smoothed synthetic OHLC candles", icon: HeikinAshiChartIcon },
  { id: "renko", label: "Renko", description: "Close-based synthetic bricks", icon: RenkoChartIcon },
  { id: "point-and-figure", label: "Point & Figure", description: "Close-based X/O columns", icon: PointFigureChartIcon },
  { id: "kagi", label: "Kagi", description: "Close-based reversal lines", icon: KagiChartIcon },
  { id: "line-break", label: "Line Break", description: "Close breaks of recent line ranges", icon: LineBreakChartIcon },
  { id: "bar", label: "OHLC bars", description: "Open, high, low and close bars", icon: OhlcBarChartIcon },
  { id: "high-low", label: "High-low", description: "Filled high-to-low price ranges", icon: HighLowChartIcon },
  { id: "line", label: "Line", description: "Close-price line", icon: ChartLineIcon },
  { id: "line-with-markers", label: "Line with markers", description: "Close-price line with point markers", icon: ChartLineWithMarkersIcon },
  { id: "step-line", label: "Step line", description: "Close-price line drawn in steps", icon: ChartStepLineIcon },
  { id: "area", label: "Area", description: "Close-price area", icon: ChartAreaIcon },
  { id: "baseline", label: "Baseline", description: "Close price vs first loaded close", icon: ChartBaselineIcon },
  { id: "histogram", label: "Columns", description: "Close-price columns colored by change", icon: ChartHistogramIcon },
];

export {
  CHART_TYPE_VARIANTS,
  CURSOR_TOOL_IDS,
  CURSOR_VARIANTS,
  EraserIcon,
  FibonacciIcon,
  FREEHAND_TOOL_IDS,
  FREEHAND_VARIANTS,
  LINE_TOOL_IDS,
  LINE_VARIANTS,
  LongPositionIcon,
  MagnetIcon,
  MouseDefaultIcon,
  PenIcon,
  POSITION_TOOL_IDS,
  POSITION_VARIANTS,
  RectangleIcon,
  SegmentIcon,
  SHAPE_TOOL_IDS,
  SHAPE_VARIANTS,
  TextIcon,
};
