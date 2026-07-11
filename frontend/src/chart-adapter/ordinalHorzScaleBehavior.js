import { defaultHorzScaleBehavior } from "lightweight-charts";

const DefaultHorzScaleBehavior = defaultHorzScaleBehavior();

function assertObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ordinal horizontal scale item must be an object");
  }
}

function assertSafeInteger(value, field, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `Ordinal horizontal scale item ${field} must be a safe integer`,
    );
  }
}

function assertFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `Ordinal horizontal scale item ${field} must be a finite number`,
    );
  }
}

function validateOrdinalHorzScaleItem(item) {
  assertObject(item);
  assertSafeInteger(item.order, "order");
  assertFiniteNumber(item.sourceTime, "sourceTime");
  assertSafeInteger(item.sourceOrdinal, "sourceOrdinal", { minimum: 0 });
  return item;
}

function isInternalOrdinalHorzScaleItem(item) {
  return item !== null
    && typeof item === "object"
    && Number.isSafeInteger(item._ordinal_order)
    && typeof item._ordinal_sourceTime === "number"
    && Number.isFinite(item._ordinal_sourceTime)
    && Number.isSafeInteger(item._ordinal_sourceOrdinal);
}

/**
 * Horizontal-scale behavior for non-time-linear chart projections.
 *
 * `order` is the unique, strictly numeric position used by Lightweight Charts
 * for identity and sorting. `sourceTime` remains the Unix timestamp used for
 * labels and calendar-aware tick weights. `sourceOrdinal` disambiguates
 * multiple projected elements emitted by the same source bar.
 */
export class OrdinalHorzScaleBehavior extends DefaultHorzScaleBehavior {
  preprocessData(data) {
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      validateOrdinalHorzScaleItem(item?.time);
    }
  }

  createConverterToInternalObj(data) {
    for (const item of data) {
      validateOrdinalHorzScaleItem(item?.time);
    }
    return (item) => this.convertHorzItemToInternal(item);
  }

  convertHorzItemToInternal(item) {
    const validated = validateOrdinalHorzScaleItem(item);
    const internalTime = super.convertHorzItemToInternal(validated.sourceTime);
    return Object.assign(internalTime, {
      _ordinal_order: validated.order,
      _ordinal_sourceOrdinal: validated.sourceOrdinal,
      _ordinal_sourceTime: validated.sourceTime,
    });
  }

  key(item) {
    if (isInternalOrdinalHorzScaleItem(item)) {
      return item._ordinal_order;
    }
    return validateOrdinalHorzScaleItem(item).order;
  }

  cacheKey(item) {
    if (!isInternalOrdinalHorzScaleItem(item)) {
      throw new TypeError("Ordinal horizontal scale cache item must be internal");
    }
    return item._ordinal_order;
  }

  formatHorzItem(item) {
    const internalItem = isInternalOrdinalHorzScaleItem(item)
      ? item
      : this.convertHorzItemToInternal(item);
    return super.formatHorzItem(internalItem);
  }

  formatTickmark(item, localizationOptions) {
    if (!isInternalOrdinalHorzScaleItem(item?.time)) {
      throw new TypeError("Ordinal horizontal scale tick mark time must be internal");
    }
    return super.formatTickmark({
      ...item,
      originalTime: item.time._ordinal_sourceTime,
    }, localizationOptions);
  }
}

export function createOrdinalHorzScaleBehavior() {
  return new OrdinalHorzScaleBehavior();
}
