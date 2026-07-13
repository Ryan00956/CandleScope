import type {
  IndicatorAnnotationPoint,
  IndicatorAnnotationType,
  IndicatorBarColor,
  IndicatorBgColor,
  IndicatorColorPoint,
  CustomIndicatorRecord,
  IndicatorDeleteResponse,
  IndicatorErrorDetail,
  IndicatorFill,
  IndicatorHLine,
  IndicatorLine,
  IndicatorMarker,
  IndicatorParameterSchema,
  IndicatorPayloadEnvelope,
  IndicatorPreset,
  IndicatorRange,
  IndicatorRangeBatchResponse,
  IndicatorRegistrySpec,
  IndicatorRevision,
  IndicatorSignal,
  IndicatorUnifiedAnnotation,
  IndicatorUnifiedSeries,
  IndicatorValuePoint,
  PyneSecurityPolicy,
} from "./indicatorTypes.js";

export class IndicatorPayloadError extends TypeError {
  path: string;

  constructor(path: string, message: string) {
    super(`Invalid indicator payload at ${path}: ${message}`);
    this.name = "IndicatorPayloadError";
    this.path = path;
  }
}

export function isIndicatorRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectIndicatorRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!isIndicatorRecord(value))
    throw new IndicatorPayloadError(path, "expected an object");
  return value;
}

export function expectIndicatorArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    throw new IndicatorPayloadError(path, "expected an array");
  return value;
}

export function expectIndicatorString(value: unknown, path: string): string {
  if (typeof value !== "string")
    throw new IndicatorPayloadError(path, "expected a string");
  return value;
}

export function expectIndicatorNonEmptyString(
  value: unknown,
  path: string,
): string {
  const parsed = expectIndicatorString(value, path);
  if (!parsed.trim())
    throw new IndicatorPayloadError(path, "expected a non-empty string");
  return parsed;
}

export function expectIndicatorBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    throw new IndicatorPayloadError(path, "expected a boolean");
  return value;
}

export function expectIndicatorFiniteNumber(
  value: unknown,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IndicatorPayloadError(path, "expected a finite number");
  }
  return value;
}

export function expectIndicatorPositiveInteger(
  value: unknown,
  path: string,
): number {
  const parsed = expectIndicatorFiniteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new IndicatorPayloadError(path, "expected a positive integer");
  }
  return parsed;
}

export function optionalIndicatorString(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : expectIndicatorString(value, path);
}

export function optionalIndicatorFiniteNumber(
  value: unknown,
  path: string,
): number | undefined {
  return value === undefined || value === null
    ? undefined
    : expectIndicatorFiniteNumber(value, path);
}

export function indicatorStringArray(value: unknown, path: string): string[] {
  return expectIndicatorArray(value, path).map((item, index) =>
    expectIndicatorString(item, `${path}[${index}]`),
  );
}

function optionalIndicatorBoolean(
  value: unknown,
  path: string,
): boolean | undefined {
  return value === undefined || value === null
    ? undefined
    : expectIndicatorBoolean(value, path);
}

function parseOptionalArray<T>(
  value: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => T,
): T[] {
  if (value === undefined || value === null) return [];
  return expectIndicatorArray(value, path).map((item, index) =>
    parser(item, `${path}[${index}]`),
  );
}

function parseIndicatorValuePoint(
  value: unknown,
  path: string,
): IndicatorValuePoint {
  const record = expectIndicatorRecord(value, path);
  return {
    time: expectIndicatorFiniteNumber(record.time, `${path}.time`),
    value: expectIndicatorFiniteNumber(record.value, `${path}.value`),
    ...(optionalIndicatorString(record.color, `${path}.color`) !== undefined
      ? { color: optionalIndicatorString(record.color, `${path}.color`) }
      : {}),
  };
}

function parseIndicatorColorPoint(
  value: unknown,
  path: string,
): IndicatorColorPoint {
  const record = expectIndicatorRecord(value, path);
  const point: IndicatorColorPoint = {
    time: expectIndicatorFiniteNumber(record.time, `${path}.time`),
    color: expectIndicatorString(record.color, `${path}.color`),
  };
  const pointValue = optionalIndicatorFiniteNumber(
    record.value,
    `${path}.value`,
  );
  if (pointValue !== undefined) point.value = pointValue;
  return point;
}

function parseIndicatorAnnotationPoint(
  value: unknown,
  path: string,
): IndicatorAnnotationPoint {
  const record = expectIndicatorRecord(value, path);
  const time = optionalIndicatorFiniteNumber(record.time, `${path}.time`);
  const pointValue = optionalIndicatorFiniteNumber(
    record.value,
    `${path}.value`,
  );
  if (time === undefined && pointValue === undefined) {
    throw new IndicatorPayloadError(path, "expected time or value");
  }
  const optionalFields = {
    color: optionalIndicatorString(record.color, `${path}.color`),
    text: optionalIndicatorString(record.text, `${path}.text`),
    position: optionalIndicatorString(record.position, `${path}.position`),
    shape: optionalIndicatorString(record.shape, `${path}.shape`),
    size: optionalIndicatorString(record.size, `${path}.size`),
    endTime: optionalIndicatorFiniteNumber(
      record.endTime ?? record.end_time,
      `${path}.endTime`,
    ),
  };
  const definedFields = Object.fromEntries(
    Object.entries(optionalFields).filter(([, item]) => item !== undefined),
  );
  return time !== undefined
    ? {
        time,
        ...(pointValue !== undefined ? { value: pointValue } : {}),
        ...definedFields,
      }
    : { value: pointValue as number, ...definedFields };
}

function parseStyleRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  return value === undefined || value === null
    ? {}
    : expectIndicatorRecord(value, path);
}

function parseIndicatorLine(value: unknown, path: string): IndicatorLine {
  const record = expectIndicatorRecord(value, path);
  const data = parseOptionalArray(
    record.data,
    `${path}.data`,
    parseIndicatorValuePoint,
  );
  const line: IndicatorLine = { data };
  const strings = [
    "id",
    "indicatorId",
    "localId",
    "name",
    "title",
    "color",
    "type",
    "pane",
    "scale",
  ] as const;
  for (const key of strings) {
    const parsed = optionalIndicatorString(record[key], `${path}.${key}`);
    if (parsed !== undefined) line[key] = parsed;
  }
  const outputName = record.outputName ?? record.output_name;
  if (outputName === null) line.outputName = null;
  else {
    const parsed = optionalIndicatorString(outputName, `${path}.outputName`);
    if (parsed !== undefined) line.outputName = parsed;
  }
  const lineWidth = optionalIndicatorFiniteNumber(
    record.lineWidth ?? record.line_width,
    `${path}.lineWidth`,
  );
  const lineStyle = optionalIndicatorFiniteNumber(
    record.lineStyle ?? record.line_style,
    `${path}.lineStyle`,
  );
  const zIndex = optionalIndicatorFiniteNumber(
    record.zIndex ?? record.z_index,
    `${path}.zIndex`,
  );
  const overlay = optionalIndicatorBoolean(record.overlay, `${path}.overlay`);
  if (lineWidth !== undefined) line.lineWidth = lineWidth;
  if (lineStyle !== undefined) line.lineStyle = lineStyle;
  if (zIndex !== undefined) line.zIndex = zIndex;
  if (overlay !== undefined) line.overlay = overlay;
  if (record.colorData !== undefined || record.color_data !== undefined) {
    line.colorData = parseOptionalArray(
      record.colorData ?? record.color_data,
      `${path}.colorData`,
      parseIndicatorColorPoint,
    );
  }
  return line;
}

function parseIndicatorUnifiedSeries(
  value: unknown,
  path: string,
): IndicatorUnifiedSeries {
  const record = expectIndicatorRecord(value, path);
  const style = parseStyleRecord(record.style, `${path}.style`);
  const colorData = parseOptionalArray(
    style.colorData ?? style.color_data,
    `${path}.style.colorData`,
    parseIndicatorColorPoint,
  );
  return {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    localId: expectIndicatorNonEmptyString(
      record.localId ?? record.local_id,
      `${path}.localId`,
    ),
    indicatorId:
      record.indicatorId === null || record.indicator_id === null
        ? null
        : optionalIndicatorString(
            record.indicatorId ?? record.indicator_id,
            `${path}.indicatorId`,
          ),
    pane: optionalIndicatorString(record.pane, `${path}.pane`) ?? "main",
    type: optionalIndicatorString(record.type, `${path}.type`) ?? "line",
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorValuePoint,
    ),
    style: {
      title: optionalIndicatorString(style.title, `${path}.style.title`) ?? "",
      color:
        optionalIndicatorString(style.color, `${path}.style.color`) ??
        "#f59e0b",
      lineWidth:
        optionalIndicatorFiniteNumber(
          style.lineWidth ?? style.line_width,
          `${path}.style.lineWidth`,
        ) ?? 2,
      lineStyle:
        optionalIndicatorFiniteNumber(
          style.lineStyle ?? style.line_style,
          `${path}.style.lineStyle`,
        ) ?? 0,
      ...(colorData.length > 0 ? { colorData } : {}),
    },
    scale: optionalIndicatorString(record.scale, `${path}.scale`),
    zIndex: optionalIndicatorFiniteNumber(
      record.zIndex ?? record.z_index,
      `${path}.zIndex`,
    ),
  };
}

const ANNOTATION_TYPES: ReadonlySet<string> = new Set([
  "marker",
  "hline",
  "bgcolor",
  "barcolor",
  "signal",
]);

function parseIndicatorUnifiedAnnotation(
  value: unknown,
  path: string,
): IndicatorUnifiedAnnotation {
  const record = expectIndicatorRecord(value, path);
  const type = expectIndicatorString(record.type, `${path}.type`);
  if (!ANNOTATION_TYPES.has(type)) {
    throw new IndicatorPayloadError(
      `${path}.type`,
      `unsupported annotation type ${JSON.stringify(type)}`,
    );
  }
  return {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    indicatorId:
      record.indicatorId === null || record.indicator_id === null
        ? null
        : optionalIndicatorString(
            record.indicatorId ?? record.indicator_id,
            `${path}.indicatorId`,
          ),
    pane: optionalIndicatorString(record.pane, `${path}.pane`) ?? "main",
    type: type as IndicatorAnnotationType,
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
    style: parseStyleRecord(record.style, `${path}.style`),
    scale: optionalIndicatorString(record.scale, `${path}.scale`),
    zIndex: optionalIndicatorFiniteNumber(
      record.zIndex ?? record.z_index,
      `${path}.zIndex`,
    ),
  };
}

function parseLegacyMarker(value: unknown, path: string): IndicatorMarker {
  const record = expectIndicatorRecord(value, path);
  return {
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    shape: optionalIndicatorString(record.shape, `${path}.shape`),
    color: optionalIndicatorString(record.color, `${path}.color`),
    text: optionalIndicatorString(record.text, `${path}.text`),
    position: optionalIndicatorString(record.position, `${path}.position`),
    size: optionalIndicatorString(record.size, `${path}.size`),
  };
}

function parseLegacyFill(value: unknown, path: string): IndicatorFill {
  const record = expectIndicatorRecord(value, path);
  const localSeriesIds = record.localSeriesIds ?? record.local_series_ids;
  const seriesIds = record.seriesIds ?? record.series_ids;
  const parseNullableStrings = (
    items: unknown,
    itemsPath: string,
  ): Array<string | null> =>
    expectIndicatorArray(items, itemsPath).map((item, index) =>
      item === null
        ? null
        : expectIndicatorString(item, `${itemsPath}[${index}]`),
    );
  const fill: IndicatorFill = {
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    plot1_id: optionalIndicatorString(record.plot1_id, `${path}.plot1_id`),
    plot2_id: optionalIndicatorString(record.plot2_id, `${path}.plot2_id`),
    color: optionalIndicatorString(record.color, `${path}.color`),
    title: optionalIndicatorString(record.title, `${path}.title`),
    type: optionalIndicatorString(record.type, `${path}.type`),
    style: parseStyleRecord(record.style, `${path}.style`),
  };
  if (localSeriesIds !== undefined)
    fill.localSeriesIds = parseNullableStrings(
      localSeriesIds,
      `${path}.localSeriesIds`,
    );
  if (seriesIds !== undefined)
    fill.seriesIds = indicatorStringArray(seriesIds, `${path}.seriesIds`);
  if (record.data !== undefined)
    fill.data = parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    );
  return fill;
}

function parseLegacyHLine(value: unknown, path: string): IndicatorHLine {
  const record = expectIndicatorRecord(value, path);
  const linestyle = record.linestyle ?? record.lineStyle ?? record.line_style;
  if (
    linestyle !== undefined &&
    typeof linestyle !== "string" &&
    typeof linestyle !== "number"
  ) {
    throw new IndicatorPayloadError(
      `${path}.linestyle`,
      "expected a string or number",
    );
  }
  return {
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    price: optionalIndicatorFiniteNumber(record.price, `${path}.price`),
    title: optionalIndicatorString(record.title, `${path}.title`),
    color: optionalIndicatorString(record.color, `${path}.color`),
    linestyle,
    linewidth: optionalIndicatorFiniteNumber(
      record.linewidth ?? record.lineWidth,
      `${path}.linewidth`,
    ),
    ...(record.data !== undefined
      ? {
          data: parseOptionalArray(
            record.data,
            `${path}.data`,
            parseIndicatorAnnotationPoint,
          ),
        }
      : {}),
  };
}

function parseLegacyBgColor(value: unknown, path: string): IndicatorBgColor {
  const record = expectIndicatorRecord(value, path);
  return {
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    title: optionalIndicatorString(record.title, `${path}.title`),
    color: optionalIndicatorString(record.color, `${path}.color`),
    ...(record.regions !== undefined
      ? {
          regions: parseOptionalArray(
            record.regions,
            `${path}.regions`,
            parseIndicatorAnnotationPoint,
          ),
        }
      : {}),
    ...(record.data !== undefined
      ? {
          data: parseOptionalArray(
            record.data,
            `${path}.data`,
            parseIndicatorAnnotationPoint,
          ),
        }
      : {}),
  };
}

function parseLegacyBarColor(value: unknown, path: string): IndicatorBarColor {
  const record = expectIndicatorRecord(value, path);
  return {
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorColorPoint,
    ),
  };
}

function parseLegacySignal(value: unknown, path: string): IndicatorSignal {
  const record = expectIndicatorRecord(value, path);
  return {
    indicatorId: optionalIndicatorString(
      record.indicatorId ?? record.indicator_id,
      `${path}.indicatorId`,
    ),
    id: optionalIndicatorString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`),
    name: optionalIndicatorString(record.name, `${path}.name`),
    side: optionalIndicatorString(record.side, `${path}.side`),
    message: optionalIndicatorString(record.message, `${path}.message`),
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
  };
}

export function parseIndicatorParameterSchemas(
  value: unknown,
  path = "indicator.param_schema",
): IndicatorParameterSchema[] {
  return parseOptionalArray(value, path, (item, itemPath) => {
    const record = expectIndicatorRecord(item, itemPath);
    const key = optionalIndicatorString(record.key, `${itemPath}.key`);
    const name = optionalIndicatorString(record.name, `${itemPath}.name`);
    if (!key && !name)
      throw new IndicatorPayloadError(itemPath, "expected key or name");
    const result = {
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
      label: optionalIndicatorString(record.label, `${itemPath}.label`),
      type: optionalIndicatorString(record.type, `${itemPath}.type`),
      default: record.default,
      min: optionalIndicatorFiniteNumber(record.min, `${itemPath}.min`),
      max: optionalIndicatorFiniteNumber(record.max, `${itemPath}.max`),
      step: optionalIndicatorFiniteNumber(record.step, `${itemPath}.step`),
      ...(record.options !== undefined
        ? {
            options: indicatorStringArray(
              record.options,
              `${itemPath}.options`,
            ),
          }
        : {}),
    };
    return result as IndicatorParameterSchema;
  });
}

export function parseIndicatorRange(
  value: unknown,
  path = "indicator.range",
): IndicatorRange {
  const record = expectIndicatorRecord(value, path);
  const start = expectIndicatorFiniteNumber(record.start, `${path}.start`);
  const end = expectIndicatorFiniteNumber(record.end, `${path}.end`);
  if (start > end)
    throw new IndicatorPayloadError(path, "start must not exceed end");
  return { start: Math.floor(start), end: Math.floor(end) };
}

export function parseIndicatorRevision(
  value: unknown,
  path = "indicator.dataRevision",
): IndicatorRevision {
  const record = expectIndicatorRecord(value, path);
  const dirtyRange = record.dirtyRange ?? record.dirty_range;
  const historyInvalid = optionalIndicatorBoolean(
    record.historyInvalid ?? record.history_invalid,
    `${path}.historyInvalid`,
  );
  if (historyInvalid === false) {
    throw new IndicatorPayloadError(
      `${path}.historyInvalid`,
      "expected true when present",
    );
  }
  const correctionRevisionValue =
    record.correctionRevision ?? record.correction_revision;
  let correctionRevision: string | undefined;
  if (typeof correctionRevisionValue === "string") {
    correctionRevision = correctionRevisionValue;
  } else if (
    typeof correctionRevisionValue === "number" &&
    Number.isFinite(correctionRevisionValue)
  ) {
    correctionRevision = String(correctionRevisionValue);
  } else if (
    correctionRevisionValue !== undefined &&
    correctionRevisionValue !== null
  ) {
    throw new IndicatorPayloadError(
      `${path}.correctionRevision`,
      "expected a string or finite number",
    );
  }
  return {
    serverEpoch: optionalIndicatorString(
      record.serverEpoch ?? record.server_epoch,
      `${path}.serverEpoch`,
    ),
    correctionRevision,
    closedThrough: optionalIndicatorFiniteNumber(
      record.closedThrough ?? record.closed_through,
      `${path}.closedThrough`,
    ),
    token: optionalIndicatorString(record.token, `${path}.token`),
    ...(dirtyRange !== undefined && dirtyRange !== null
      ? { dirtyRange: parseIndicatorRange(dirtyRange, `${path}.dirtyRange`) }
      : {}),
    ...(historyInvalid === true ? { historyInvalid: true } : {}),
  };
}

function parseIndicatorErrorDetail(
  value: unknown,
  path: string,
): IndicatorErrorDetail {
  const record = expectIndicatorRecord(value, path);
  return {
    message: expectIndicatorNonEmptyString(record.message, `${path}.message`),
    line: optionalIndicatorFiniteNumber(record.line, `${path}.line`),
    column: optionalIndicatorFiniteNumber(record.column, `${path}.column`),
    hint: optionalIndicatorString(record.hint, `${path}.hint`),
  };
}

export function parseIndicatorPayloadEnvelope(
  value: unknown,
  path = "indicator",
): IndicatorPayloadEnvelope {
  const record = expectIndicatorRecord(value, path);
  const ok =
    record.ok === undefined || record.ok === null
      ? null
      : expectIndicatorBoolean(record.ok, `${path}.ok`);
  const range = record.range;
  const revision = record.dataRevision ?? record.data_revision;
  return {
    ok,
    schemaVersion: optionalIndicatorFiniteNumber(
      record.schemaVersion ?? record.schema_version,
      `${path}.schemaVersion`,
    ),
    outputSchemaVersion: optionalIndicatorFiniteNumber(
      record.outputSchemaVersion ?? record.output_schema_version,
      `${path}.outputSchemaVersion`,
    ),
    error:
      record.error === null
        ? null
        : optionalIndicatorString(record.error, `${path}.error`),
    detail: record.detail,
    code: optionalIndicatorString(record.code, `${path}.code`),
    errorDetail:
      record.errorDetail === undefined && record.error_detail === undefined
        ? undefined
        : parseIndicatorErrorDetail(
            record.errorDetail ?? record.error_detail,
            `${path}.errorDetail`,
          ),
    lines: parseOptionalArray(
      record.lines,
      `${path}.lines`,
      parseIndicatorLine,
    ),
    series: parseOptionalArray(
      record.series,
      `${path}.series`,
      parseIndicatorUnifiedSeries,
    ),
    annotations: parseOptionalArray(
      record.annotations,
      `${path}.annotations`,
      parseIndicatorUnifiedAnnotation,
    ),
    fills: parseOptionalArray(record.fills, `${path}.fills`, parseLegacyFill),
    legacyFills: parseOptionalArray(
      record.legacyFills ?? record.legacy_fills,
      `${path}.legacyFills`,
      parseLegacyFill,
    ),
    markers: parseOptionalArray(
      record.markers,
      `${path}.markers`,
      parseLegacyMarker,
    ),
    hlines: parseOptionalArray(
      record.hlines,
      `${path}.hlines`,
      parseLegacyHLine,
    ),
    bgcolors: parseOptionalArray(
      record.bgcolors,
      `${path}.bgcolors`,
      parseLegacyBgColor,
    ),
    barcolors: parseOptionalArray(
      record.barcolors,
      `${path}.barcolors`,
      parseLegacyBarColor,
    ),
    signals: parseOptionalArray(
      record.signals,
      `${path}.signals`,
      parseLegacySignal,
    ),
    param_schema: parseIndicatorParameterSchemas(
      record.param_schema ?? record.paramSchema,
      `${path}.param_schema`,
    ),
    ...(range !== undefined && range !== null
      ? { range: parseIndicatorRange(range, `${path}.range`) }
      : {}),
    ...(revision !== undefined && revision !== null
      ? {
          dataRevision: parseIndicatorRevision(
            revision,
            `${path}.dataRevision`,
          ),
        }
      : {}),
    __httpStatus: optionalIndicatorFiniteNumber(
      record.__httpStatus,
      `${path}.__httpStatus`,
    ),
  };
}

function parseIndicatorParams(
  value: unknown,
  path: string,
): Record<string, unknown> {
  return value === undefined || value === null
    ? {}
    : expectIndicatorRecord(value, path);
}

export function parseIndicatorPreset(
  value: unknown,
  path = "indicator.preset",
): IndicatorPreset {
  const record = expectIndicatorRecord(value, path);
  return {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    name: expectIndicatorNonEmptyString(record.name, `${path}.name`),
    engineName: expectIndicatorNonEmptyString(
      record.engineName,
      `${path}.engineName`,
    ),
    script: expectIndicatorString(record.script, `${path}.script`),
    params: parseIndicatorParams(record.params, `${path}.params`),
    description:
      optionalIndicatorString(record.description, `${path}.description`) ?? "",
    category:
      optionalIndicatorString(record.category, `${path}.category`) ?? "",
    paramSchema: parseIndicatorParameterSchemas(
      record.paramSchema,
      `${path}.paramSchema`,
    ),
    outputs:
      record.outputs === undefined
        ? []
        : indicatorStringArray(record.outputs, `${path}.outputs`),
    is_builtin:
      record.is_builtin === undefined
        ? true
        : expectIndicatorBoolean(record.is_builtin, `${path}.is_builtin`),
    defaultEnabled:
      record.defaultEnabled === undefined
        ? false
        : expectIndicatorBoolean(
            record.defaultEnabled,
            `${path}.defaultEnabled`,
          ),
    paneTarget:
      optionalIndicatorString(record.paneTarget, `${path}.paneTarget`) ?? "sub",
    isPreset: true,
  };
}

export function parseIndicatorPresetList(
  value: unknown,
  path = "indicator.presets",
): IndicatorPreset[] {
  return expectIndicatorArray(value, path).map((item, index) =>
    parseIndicatorPreset(item, `${path}[${index}]`),
  );
}

export function parseIndicatorRegistrySpec(
  value: unknown,
  path = "indicator.registry",
): IndicatorRegistrySpec {
  const record = expectIndicatorRecord(value, path);
  return {
    name: expectIndicatorNonEmptyString(record.name, `${path}.name`),
    display_name: expectIndicatorNonEmptyString(
      record.display_name,
      `${path}.display_name`,
    ),
    description:
      optionalIndicatorString(record.description, `${path}.description`) ?? "",
    category:
      optionalIndicatorString(record.category, `${path}.category`) ?? "",
    inputs:
      record.inputs === undefined
        ? []
        : indicatorStringArray(record.inputs, `${path}.inputs`),
    outputs:
      record.outputs === undefined
        ? []
        : indicatorStringArray(record.outputs, `${path}.outputs`),
    params: parseIndicatorParams(record.params, `${path}.params`),
    paramSchema: parseIndicatorParameterSchemas(
      record.paramSchema,
      `${path}.paramSchema`,
    ),
    is_builtin:
      record.is_builtin === undefined
        ? true
        : expectIndicatorBoolean(record.is_builtin, `${path}.is_builtin`),
  };
}

export function parseIndicatorRegistryList(
  value: unknown,
  path = "indicator.registry",
): IndicatorRegistrySpec[] {
  return expectIndicatorArray(value, path).map((item, index) =>
    parseIndicatorRegistrySpec(item, `${path}[${index}]`),
  );
}

export function parseCustomIndicatorRecord(
  value: unknown,
  path = "indicator.custom",
): CustomIndicatorRecord {
  const record = expectIndicatorRecord(value, path);
  const securityMode = record.securityMode;
  return {
    schemaVersion:
      optionalIndicatorFiniteNumber(
        record.schemaVersion,
        `${path}.schemaVersion`,
      ) ?? 1,
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    kind: expectIndicatorNonEmptyString(record.kind, `${path}.kind`),
    name: expectIndicatorNonEmptyString(record.name, `${path}.name`),
    description:
      optionalIndicatorString(record.description, `${path}.description`) ?? "",
    script: expectIndicatorString(record.script, `${path}.script`),
    params: parseIndicatorParams(record.params, `${path}.params`),
    paramSchema: parseIndicatorParameterSchemas(
      record.paramSchema,
      `${path}.paramSchema`,
    ),
    renderHints: parseIndicatorParams(
      record.renderHints,
      `${path}.renderHints`,
    ),
    securityMode:
      securityMode === null
        ? null
        : optionalIndicatorString(securityMode, `${path}.securityMode`),
    createdAt: optionalIndicatorFiniteNumber(
      record.createdAt ?? record.created_at,
      `${path}.createdAt`,
    ),
    updatedAt: optionalIndicatorFiniteNumber(
      record.updatedAt ?? record.updated_at,
      `${path}.updatedAt`,
    ),
  };
}

export function parseCustomIndicatorList(
  value: unknown,
  path = "indicator.custom",
): CustomIndicatorRecord[] {
  return expectIndicatorArray(value, path).map((item, index) =>
    parseCustomIndicatorRecord(item, `${path}[${index}]`),
  );
}

export function parsePyneSecurityPolicy(
  value: unknown,
  path = "indicator.pyneSecurity",
): PyneSecurityPolicy {
  const record = expectIndicatorRecord(value, path);
  return {
    ...record,
    mode: expectIndicatorNonEmptyString(record.mode, `${path}.mode`),
    timeoutSeconds: expectIndicatorFiniteNumber(
      record.timeoutSeconds,
      `${path}.timeoutSeconds`,
    ),
  };
}

export function parseIndicatorRangeBatchResponse(
  value: unknown,
  path = "indicator.rangeBatch",
): IndicatorRangeBatchResponse {
  const record = expectIndicatorRecord(value, path);
  return {
    ok: expectIndicatorBoolean(record.ok, `${path}.ok`),
    results: expectIndicatorArray(record.results, `${path}.results`).map(
      (item, index) => {
        const itemPath = `${path}.results[${index}]`;
        const result = expectIndicatorRecord(item, itemPath);
        return {
          clientId: expectIndicatorNonEmptyString(
            result.clientId,
            `${itemPath}.clientId`,
          ),
          payload: parseIndicatorPayloadEnvelope(
            result.payload,
            `${itemPath}.payload`,
          ),
        };
      },
    ),
  };
}

export function parseIndicatorDeleteResponse(
  value: unknown,
  path = "indicator.delete",
): IndicatorDeleteResponse {
  const record = expectIndicatorRecord(value, path);
  if (expectIndicatorBoolean(record.ok, `${path}.ok`) !== true) {
    throw new IndicatorPayloadError(`${path}.ok`, "expected true");
  }
  return {
    ok: true,
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
  };
}
