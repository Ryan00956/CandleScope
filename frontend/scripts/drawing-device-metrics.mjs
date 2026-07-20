/**
 * Chrome's device metrics override is transported through a float-backed
 * compositor path on some Windows builds. A requested DPR of 1 can therefore
 * round-trip as 1.0000000298023224. The tolerance is intentionally much
 * smaller than a meaningful display-scale change while accepting that binary
 * representation noise.
 */
export const DEVICE_METRICS_DPR_EPSILON = 0.001;

export function devicePixelRatioMatches(actual, configured, {
  epsilon = DEVICE_METRICS_DPR_EPSILON,
} = {}) {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && actual > 0
    && typeof configured === "number"
    && Number.isFinite(configured)
    && configured > 0
    && typeof epsilon === "number"
    && Number.isFinite(epsilon)
    && epsilon >= 0
    && Math.abs(actual - configured) <= epsilon;
}
