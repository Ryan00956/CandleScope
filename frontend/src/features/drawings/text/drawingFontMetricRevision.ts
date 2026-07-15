import { useEffect, useState } from "react";

const FONT_METRIC_EVENTS = ["loadingdone", "loadingerror"] as const;

type DrawingFontMetricEvent = (typeof FONT_METRIC_EVENTS)[number];
type DrawingFontMetricListener = () => void;

export interface DrawingFontMetricSource {
  readonly ready: PromiseLike<unknown>;
  addEventListener(type: DrawingFontMetricEvent, listener: DrawingFontMetricListener): void;
  removeEventListener(type: DrawingFontMetricEvent, listener: DrawingFontMetricListener): void;
}

function documentFontMetricSource(): DrawingFontMetricSource | null {
  if (typeof document === "undefined") return null;
  const candidate = (document as Document & { fonts?: Partial<DrawingFontMetricSource> }).fonts;
  if (!candidate
    || typeof candidate.addEventListener !== "function"
    || typeof candidate.removeEventListener !== "function"
    || candidate.ready === undefined
    || typeof candidate.ready.then !== "function") return null;
  return candidate as DrawingFontMetricSource;
}

export function subscribeDrawingFontMetricRevision(
  source: DrawingFontMetricSource | null,
  onRevision: DrawingFontMetricListener,
): () => void {
  if (!source) return () => {};

  let active = true;
  const advance = () => {
    if (active) onRevision();
  };

  for (const event of FONT_METRIC_EVENTS) {
    source.addEventListener(event, advance);
  }
  void Promise.resolve(source.ready).then(advance, () => {});

  return () => {
    if (!active) return;
    active = false;
    for (const event of FONT_METRIC_EVENTS) {
      source.removeEventListener(event, advance);
    }
  };
}

export function useDrawingFontMetricRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => subscribeDrawingFontMetricRevision(
    documentFontMetricSource(),
    () => setRevision((current) => current + 1),
  ), []);

  return revision;
}
