import { createHash } from "node:crypto";

export const MIN_WINDOW_WIDTH_DIP = 640;
export const MIN_WINDOW_HEIGHT_DIP = 480;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeDisplay(display) {
  const scaleFactor = Math.max(0.25, finiteNumber(display?.scaleFactor, 1));
  const bounds = display?.bounds || {};
  const workArea = display?.workArea || bounds;
  return {
    id: finiteNumber(display?.id, -1),
    label: String(display?.label || "unknown-display").slice(0, 256),
    internal: display?.internal === true,
    rotation: finiteNumber(display?.rotation, 0),
    scaleFactor,
    bounds: {
      x: finiteNumber(bounds.x),
      y: finiteNumber(bounds.y),
      width: Math.max(1, finiteNumber(bounds.width, 1)),
      height: Math.max(1, finiteNumber(bounds.height, 1)),
    },
    workArea: {
      x: finiteNumber(workArea.x),
      y: finiteNumber(workArea.y),
      width: Math.max(1, finiteNumber(workArea.width, 1)),
      height: Math.max(1, finiteNumber(workArea.height, 1)),
    },
  };
}

export function displayFingerprint(display) {
  const normalized = normalizeDisplay(display);
  const nativeWidth = Math.round(normalized.bounds.width * normalized.scaleFactor);
  const nativeHeight = Math.round(normalized.bounds.height * normalized.scaleFactor);
  const identity = [
    "candlescope-display-v1",
    normalized.id,
    normalized.label,
    `${nativeWidth}x${nativeHeight}`,
    normalized.internal ? "internal" : "external",
    normalized.rotation,
  ].join("|");
  return `display-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function clampBoundsToWorkArea(boundsDip, workArea) {
  const area = normalizeDisplay({ bounds: workArea, workArea }).workArea;
  const source = boundsDip || {};
  const width = Math.min(
    area.width,
    Math.max(Math.min(MIN_WINDOW_WIDTH_DIP, area.width), finiteNumber(source.width, 1280)),
  );
  const height = Math.min(
    area.height,
    Math.max(Math.min(MIN_WINDOW_HEIGHT_DIP, area.height), finiteNumber(source.height, 800)),
  );
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, finiteNumber(source.x, area.x))),
    y: Math.min(area.y + area.height - height, Math.max(area.y, finiteNumber(source.y, area.y))),
    width,
    height,
  };
}

function overlapArea(bounds, area) {
  if (!bounds) return 0;
  const left = Math.max(finiteNumber(bounds.x), area.x);
  const top = Math.max(finiteNumber(bounds.y), area.y);
  const right = Math.min(
    finiteNumber(bounds.x) + Math.max(0, finiteNumber(bounds.width)),
    area.x + area.width,
  );
  const bottom = Math.min(
    finiteNumber(bounds.y) + Math.max(0, finiteNumber(bounds.height)),
    area.y + area.height,
  );
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function chooseRestoreDisplay(saved, displays, primaryDisplayId) {
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new Error("At least one display is required to restore a window");
  }
  const normalized = displays.map(normalizeDisplay);
  const exact = saved?.monitorFingerprint
    ? normalized.find((display) => displayFingerprint(display) === saved.monitorFingerprint)
    : null;
  if (exact) return { display: exact, reason: "fingerprint" };

  if (saved?.boundsDip) {
    const ranked = normalized
      .map((display) => ({ display, overlap: overlapArea(saved.boundsDip, display.workArea) }))
      .sort((left, right) => right.overlap - left.overlap);
    if (ranked[0]?.overlap > 0) return { display: ranked[0].display, reason: "overlap" };
  }

  const primary = normalized.find((display) => display.id === primaryDisplayId) || normalized[0];
  return { display: primary, reason: saved?.monitorFingerprint ? "missing-monitor" : "primary" };
}

export function restoreWindowPlacement(saved, displays, primaryDisplayId) {
  const selected = chooseRestoreDisplay(saved, displays, primaryDisplayId);
  const display = selected.display;
  return {
    boundsDip: clampBoundsToWorkArea(saved?.boundsDip, display.workArea),
    dpiScale: display.scaleFactor,
    monitorFingerprint: displayFingerprint(display),
    reason: selected.reason,
    displayId: display.id,
  };
}

export function snapshotDisplay(display) {
  const normalized = normalizeDisplay(display);
  return {
    ...normalized,
    fingerprint: displayFingerprint(normalized),
  };
}
