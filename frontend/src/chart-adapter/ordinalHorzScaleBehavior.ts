import { defaultHorzScaleBehavior } from "lightweight-charts";
import type {
  ChartOptionsImpl,
  DataItem,
  HorzScaleItemConverterToInternalObj,
  IHorzScaleBehavior,
  InternalHorzScaleItem,
  InternalHorzScaleItemKey,
  LocalizationOptions,
  Mutable,
  SeriesDataItemTypeMap,
  SeriesType,
  TickMark,
  TickMarkWeightValue,
  Time,
  TimeMark,
  TimeScalePoint,
} from "lightweight-charts";
import type { OrdinalAxisTime } from "../features/chart-representation/chartRepresentationTypes.js";

const DefaultHorzScaleBehavior = defaultHorzScaleBehavior();

interface InternalOrdinalHorzScaleItemFields {
  _ordinal_order: number;
  _ordinal_sourceTime: number;
  _ordinal_sourceOrdinal: number;
}

type InternalOrdinalHorzScaleItem = InternalHorzScaleItem
  & InternalOrdinalHorzScaleItemFields;

function assertObject(value: unknown): asserts value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ordinal horizontal scale item must be an object");
  }
}

function assertSafeInteger(
  value: unknown,
  field: string,
  { minimum = Number.MIN_SAFE_INTEGER }: { minimum?: number } = {},
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `Ordinal horizontal scale item ${field} must be a safe integer`,
    );
  }
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `Ordinal horizontal scale item ${field} must be a finite number`,
    );
  }
}

function validateOrdinalHorzScaleItem(item: unknown): OrdinalAxisTime {
  assertObject(item);
  const order = Reflect.get(item, "order") as unknown;
  const sourceTime = Reflect.get(item, "sourceTime") as unknown;
  const sourceOrdinal = Reflect.get(item, "sourceOrdinal") as unknown;
  assertSafeInteger(order, "order");
  assertFiniteNumber(sourceTime, "sourceTime");
  assertSafeInteger(sourceOrdinal, "sourceOrdinal", { minimum: 0 });
  return { order, sourceTime, sourceOrdinal };
}

function isInternalOrdinalHorzScaleItem(
  item: unknown,
): item is InternalOrdinalHorzScaleItem {
  return item !== null
    && typeof item === "object"
    && Number.isSafeInteger(Reflect.get(item, "_ordinal_order"))
    && typeof Reflect.get(item, "_ordinal_sourceTime") === "number"
    && Number.isFinite(Reflect.get(item, "_ordinal_sourceTime"))
    && Number.isSafeInteger(Reflect.get(item, "_ordinal_sourceOrdinal"));
}

/**
 * Horizontal-scale behavior for non-time-linear chart projections.
 *
 * `order` is the unique, strictly numeric position used by Lightweight Charts
 * for identity and sorting. `sourceTime` remains the Unix timestamp used for
 * labels and calendar-aware tick weights. `sourceOrdinal` disambiguates
 * multiple projected elements emitted by the same source bar.
 */
export class OrdinalHorzScaleBehavior implements IHorzScaleBehavior<OrdinalAxisTime> {
  private readonly defaultBehavior: InstanceType<typeof DefaultHorzScaleBehavior>;

  constructor() {
    this.defaultBehavior = new DefaultHorzScaleBehavior();
  }

  options(): ChartOptionsImpl<OrdinalAxisTime> {
    const options: unknown = Reflect.apply(
      this.defaultBehavior.options,
      this.defaultBehavior,
      [],
    );
    return options as ChartOptionsImpl<OrdinalAxisTime>;
  }

  setOptions(options: ChartOptionsImpl<OrdinalAxisTime>): void {
    Reflect.apply(this.defaultBehavior.setOptions, this.defaultBehavior, [options]);
  }

  preprocessData(
    data: DataItem<OrdinalAxisTime> | DataItem<OrdinalAxisTime>[],
  ): void {
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      validateOrdinalHorzScaleItem(item?.time);
    }
  }

  createConverterToInternalObj(
    data: SeriesDataItemTypeMap<OrdinalAxisTime>[SeriesType][],
  ): HorzScaleItemConverterToInternalObj<OrdinalAxisTime> {
    for (const item of data) {
      validateOrdinalHorzScaleItem(item?.time);
    }
    return (item) => this.convertHorzItemToInternal(item);
  }

  convertHorzItemToInternal(item: OrdinalAxisTime): InternalHorzScaleItem {
    const validated = validateOrdinalHorzScaleItem(item);
    const internalTime = this.defaultBehavior.convertHorzItemToInternal(
      validated.sourceTime as Time,
    );
    return Object.assign(internalTime, {
      _ordinal_order: validated.order,
      _ordinal_sourceOrdinal: validated.sourceOrdinal,
      _ordinal_sourceTime: validated.sourceTime,
    });
  }

  key(
    item: InternalHorzScaleItem | OrdinalAxisTime,
  ): InternalHorzScaleItemKey {
    if (isInternalOrdinalHorzScaleItem(item)) {
      return item._ordinal_order as InternalHorzScaleItemKey;
    }
    return validateOrdinalHorzScaleItem(item).order as InternalHorzScaleItemKey;
  }

  cacheKey(item: InternalHorzScaleItem): number {
    if (!isInternalOrdinalHorzScaleItem(item)) {
      throw new TypeError("Ordinal horizontal scale cache item must be internal");
    }
    return item._ordinal_order;
  }

  updateFormatter(options: LocalizationOptions<OrdinalAxisTime>): void {
    Reflect.apply(this.defaultBehavior.updateFormatter, this.defaultBehavior, [options]);
  }

  formatHorzItem(item: InternalHorzScaleItem | OrdinalAxisTime): string {
    const internalItem = isInternalOrdinalHorzScaleItem(item)
      ? item
      : this.convertHorzItemToInternal(validateOrdinalHorzScaleItem(item));
    return this.defaultBehavior.formatHorzItem(internalItem);
  }

  formatTickmark(
    item: TickMark,
    localizationOptions: LocalizationOptions<OrdinalAxisTime>,
  ): string {
    if (!isInternalOrdinalHorzScaleItem(item?.time)) {
      throw new TypeError("Ordinal horizontal scale tick mark time must be internal");
    }
    return Reflect.apply(this.defaultBehavior.formatTickmark, this.defaultBehavior, [{
      ...item,
      originalTime: item.time._ordinal_sourceTime,
    }, localizationOptions]) as string;
  }

  maxTickMarkWeight(marks: TimeMark[]): TickMarkWeightValue {
    return this.defaultBehavior.maxTickMarkWeight(marks);
  }

  fillWeightsForPoints(
    sortedTimePoints: readonly Mutable<TimeScalePoint>[],
    startIndex: number,
  ): void {
    this.defaultBehavior.fillWeightsForPoints(sortedTimePoints, startIndex);
  }

  shouldResetTickmarkLabels(tickMarks: readonly TickMark[]): boolean {
    return this.defaultBehavior.shouldResetTickmarkLabels?.(tickMarks) ?? false;
  }
}

export function createOrdinalHorzScaleBehavior(): OrdinalHorzScaleBehavior {
  return new OrdinalHorzScaleBehavior();
}
