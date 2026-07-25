import type {
  IndicatorAnnotationPoint,
  IndicatorAnnotationType,
  IndicatorBarColor,
  IndicatorBgColor,
  IndicatorColorPoint,
  IndicatorComputeBatchResponse,
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
  ScriptLanguageDescriptor,
  ScriptLanguageIdentity,
  ScriptRuntimeCatalog,
  ScriptRuntimeDescriptor,
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

function parseScriptLanguageIdentity(
  value: unknown,
  path: string,
): ScriptLanguageIdentity {
  const record = expectIndicatorRecord(value, path);
  return {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    name: expectIndicatorNonEmptyString(record.name, `${path}.name`),
    extensions: indicatorStringArray(record.extensions, `${path}.extensions`),
    aliases: indicatorStringArray(record.aliases, `${path}.aliases`),
  };
}

function parseScriptRuntimeDescriptor(
  value: unknown,
  path: string,
): ScriptRuntimeDescriptor {
  const record = expectIndicatorRecord(value, path);
  const languages = expectIndicatorArray(record.languages, `${path}.languages`).map(
    (item, index) =>
      parseScriptLanguageIdentity(item, `${path}.languages[${index}]`),
  );
  if (languages.length === 0) {
    throw new IndicatorPayloadError(`${path}.languages`, "expected at least one language");
  }
  if (new Set(languages.map((item) => item.id)).size !== languages.length) {
    throw new IndicatorPayloadError(`${path}.languages`, "duplicate language id");
  }
  return {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    name: expectIndicatorNonEmptyString(record.name, `${path}.name`),
    version: expectIndicatorNonEmptyString(record.version, `${path}.version`),
    package: expectIndicatorNonEmptyString(record.package, `${path}.package`),
    languages,
    features: indicatorStringArray(record.features, `${path}.features`),
    requiredHostFeatures: indicatorStringArray(
      record.requiredHostFeatures,
      `${path}.requiredHostFeatures`,
    ),
    meta: expectIndicatorRecord(record.meta, `${path}.meta`),
  };
}

function parseScriptLanguageDescriptor(
  value: unknown,
  path: string,
): ScriptLanguageDescriptor {
  const record = expectIndicatorRecord(value, path);
  const identity = parseScriptLanguageIdentity(record, path);
  const runtimeId = record.runtimeId === null
    ? null
    : expectIndicatorNonEmptyString(record.runtimeId, `${path}.runtimeId`);
  return {
    ...identity,
    runtimeId,
    routeMode: expectIndicatorNonEmptyString(record.routeMode, `${path}.routeMode`),
    available: expectIndicatorBoolean(record.available, `${path}.available`),
    features: indicatorStringArray(record.features, `${path}.features`),
  };
}

export function parseScriptRuntimeCatalog(
  value: unknown,
  path = "indicator.runtimes",
): ScriptRuntimeCatalog {
  const record = expectIndicatorRecord(value, path);
  const schemaVersion = expectIndicatorPositiveInteger(
    record.schemaVersion,
    `${path}.schemaVersion`,
  );
  if (schemaVersion !== 1) {
    throw new IndicatorPayloadError(`${path}.schemaVersion`, "expected 1");
  }
  const runtimes = expectIndicatorArray(record.runtimes, `${path}.runtimes`).map(
    (item, index) =>
      parseScriptRuntimeDescriptor(item, `${path}.runtimes[${index}]`),
  );
  const languages = expectIndicatorArray(record.languages, `${path}.languages`).map(
    (item, index) =>
      parseScriptLanguageDescriptor(item, `${path}.languages[${index}]`),
  );
  const defaultLanguage = expectIndicatorNonEmptyString(
    record.defaultLanguage,
    `${path}.defaultLanguage`,
  );
  if (!languages.some((language) => language.id === defaultLanguage)) {
    throw new IndicatorPayloadError(
      `${path}.defaultLanguage`,
      "expected a routed language id",
    );
  }
  if (new Set(languages.map((item) => item.id)).size !== languages.length) {
    throw new IndicatorPayloadError(`${path}.languages`, "duplicate language id");
  }
  if (new Set(runtimes.map((item) => item.id)).size !== runtimes.length) {
    throw new IndicatorPayloadError(`${path}.runtimes`, "duplicate runtime id");
  }
  const runtimeById = new Map(runtimes.map((item) => [item.id, item]));
  for (const language of languages) {
    if (language.runtimeId === null) continue;
    const runtime = runtimeById.get(language.runtimeId);
    if (!runtime) {
      throw new IndicatorPayloadError(
        `${path}.languages`,
        `unknown runtime id ${language.runtimeId}`,
      );
    }
    if (!runtime.languages.some((declared) => declared.id === language.id)) {
      throw new IndicatorPayloadError(
        `${path}.languages`,
        `runtime ${language.runtimeId} does not declare ${language.id}`,
      );
    }
  }
  return { schemaVersion, defaultLanguage, languages, runtimes };
}

function parseIndicatorValuePoint(
  value: unknown,
  path: string,
): IndicatorValuePoint {
  const record = expectIndicatorRecord(value, path);
  const point: IndicatorValuePoint = {
    time: expectIndicatorFiniteNumber(record.time, `${path}.time`),
    value: expectIndicatorFiniteNumber(record.value, `${path}.value`),
  };
  const color = optionalIndicatorString(record.color, `${path}.color`);
  if (color !== undefined) point.color = color;
  return point;
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
  const visible = optionalIndicatorBoolean(record.visible, `${path}.visible`);
  const base = optionalIndicatorFiniteNumber(record.base, `${path}.base`);
  const trackPrice = optionalIndicatorBoolean(
    record.trackPrice ?? record.track_price,
    `${path}.trackPrice`,
  );
  if (lineWidth !== undefined) line.lineWidth = lineWidth;
  if (lineStyle !== undefined) line.lineStyle = lineStyle;
  if (zIndex !== undefined) line.zIndex = zIndex;
  if (overlay !== undefined) line.overlay = overlay;
  if (visible !== undefined) line.visible = visible;
  if (base !== undefined) line.base = base;
  if (trackPrice !== undefined) line.trackPrice = trackPrice;
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
  const visible = optionalIndicatorBoolean(
    style.visible,
    `${path}.style.visible`,
  );
  const base = optionalIndicatorFiniteNumber(style.base, `${path}.style.base`);
  const trackPrice = optionalIndicatorBoolean(
    style.trackPrice ?? style.track_price,
    `${path}.style.trackPrice`,
  );
  const series: IndicatorUnifiedSeries = {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    localId: expectIndicatorNonEmptyString(
      record.localId ?? record.local_id,
      `${path}.localId`,
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
      ...(visible !== undefined ? { visible } : {}),
      ...(base !== undefined ? { base } : {}),
      ...(trackPrice !== undefined ? { trackPrice } : {}),
    },
  };
  const indicatorId =
    record.indicatorId === null || record.indicator_id === null
      ? null
      : optionalIndicatorString(
          record.indicatorId ?? record.indicator_id,
          `${path}.indicatorId`,
        );
  const scale = optionalIndicatorString(record.scale, `${path}.scale`);
  const zIndex = optionalIndicatorFiniteNumber(
    record.zIndex ?? record.z_index,
    `${path}.zIndex`,
  );
  if (indicatorId !== undefined) series.indicatorId = indicatorId;
  if (scale !== undefined) series.scale = scale;
  if (zIndex !== undefined) series.zIndex = zIndex;
  return series;
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
  const annotation: IndicatorUnifiedAnnotation = {
    id: expectIndicatorNonEmptyString(record.id, `${path}.id`),
    pane: optionalIndicatorString(record.pane, `${path}.pane`) ?? "main",
    type: type as IndicatorAnnotationType,
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
    style: parseStyleRecord(record.style, `${path}.style`),
  };
  const indicatorId =
    record.indicatorId === null || record.indicator_id === null
      ? null
      : optionalIndicatorString(
          record.indicatorId ?? record.indicator_id,
          `${path}.indicatorId`,
        );
  const scale = optionalIndicatorString(record.scale, `${path}.scale`);
  const zIndex = optionalIndicatorFiniteNumber(
    record.zIndex ?? record.z_index,
    `${path}.zIndex`,
  );
  if (indicatorId !== undefined) annotation.indicatorId = indicatorId;
  if (scale !== undefined) annotation.scale = scale;
  if (zIndex !== undefined) annotation.zIndex = zIndex;
  return annotation;
}

function parseLegacyMarker(value: unknown, path: string): IndicatorMarker {
  const record = expectIndicatorRecord(value, path);
  const marker: IndicatorMarker = {
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
  };
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  const shape = optionalIndicatorString(record.shape, `${path}.shape`);
  const color = optionalIndicatorString(record.color, `${path}.color`);
  const text = optionalIndicatorString(record.text, `${path}.text`);
  const position = optionalIndicatorString(record.position, `${path}.position`);
  const size = optionalIndicatorString(record.size, `${path}.size`);
  if (indicatorId !== undefined) marker.indicatorId = indicatorId;
  if (id !== undefined) marker.id = id;
  if (pane !== undefined) marker.pane = pane;
  if (shape !== undefined) marker.shape = shape;
  if (color !== undefined) marker.color = color;
  if (text !== undefined) marker.text = text;
  if (position !== undefined) marker.position = position;
  if (size !== undefined) marker.size = size;
  return marker;
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
  const fill: IndicatorFill = { style: parseStyleRecord(record.style, `${path}.style`) };
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  const plot1Id = optionalIndicatorString(record.plot1_id, `${path}.plot1_id`);
  const plot2Id = optionalIndicatorString(record.plot2_id, `${path}.plot2_id`);
  const color = optionalIndicatorString(record.color, `${path}.color`);
  const title = optionalIndicatorString(record.title, `${path}.title`);
  const type = optionalIndicatorString(record.type, `${path}.type`);
  if (indicatorId !== undefined) fill.indicatorId = indicatorId;
  if (id !== undefined) fill.id = id;
  if (pane !== undefined) fill.pane = pane;
  if (plot1Id !== undefined) fill.plot1_id = plot1Id;
  if (plot2Id !== undefined) fill.plot2_id = plot2Id;
  if (color !== undefined) fill.color = color;
  if (title !== undefined) fill.title = title;
  if (type !== undefined) fill.type = type;
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
  const hline: IndicatorHLine = {};
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  const price = optionalIndicatorFiniteNumber(record.price, `${path}.price`);
  const title = optionalIndicatorString(record.title, `${path}.title`);
  const color = optionalIndicatorString(record.color, `${path}.color`);
  const linewidth = optionalIndicatorFiniteNumber(
    record.linewidth ?? record.lineWidth,
    `${path}.linewidth`,
  );
  if (indicatorId !== undefined) hline.indicatorId = indicatorId;
  if (id !== undefined) hline.id = id;
  if (pane !== undefined) hline.pane = pane;
  if (price !== undefined) hline.price = price;
  if (title !== undefined) hline.title = title;
  if (color !== undefined) hline.color = color;
  if (linestyle !== undefined) hline.linestyle = linestyle;
  if (linewidth !== undefined) hline.linewidth = linewidth;
  if (record.data !== undefined) {
    hline.data = parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    );
  }
  return hline;
}

function parseLegacyBgColor(value: unknown, path: string): IndicatorBgColor {
  const record = expectIndicatorRecord(value, path);
  const bgcolor: IndicatorBgColor = {};
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  const title = optionalIndicatorString(record.title, `${path}.title`);
  const color = optionalIndicatorString(record.color, `${path}.color`);
  if (indicatorId !== undefined) bgcolor.indicatorId = indicatorId;
  if (id !== undefined) bgcolor.id = id;
  if (pane !== undefined) bgcolor.pane = pane;
  if (title !== undefined) bgcolor.title = title;
  if (color !== undefined) bgcolor.color = color;
  if (record.regions !== undefined) {
    bgcolor.regions = parseOptionalArray(
      record.regions,
      `${path}.regions`,
      parseIndicatorAnnotationPoint,
    );
  }
  if (record.data !== undefined) {
    bgcolor.data = parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    );
  }
  return bgcolor;
}

function parseLegacyBarColor(value: unknown, path: string): IndicatorBarColor {
  const record = expectIndicatorRecord(value, path);
  const barcolor: IndicatorBarColor = {
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorColorPoint,
    ),
  };
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  if (indicatorId !== undefined) barcolor.indicatorId = indicatorId;
  if (id !== undefined) barcolor.id = id;
  if (pane !== undefined) barcolor.pane = pane;
  return barcolor;
}

function parseLegacySignal(value: unknown, path: string): IndicatorSignal {
  const record = expectIndicatorRecord(value, path);
  const signal: IndicatorSignal = {
    data: parseOptionalArray(
      record.data,
      `${path}.data`,
      parseIndicatorAnnotationPoint,
    ),
  };
  const indicatorId = optionalIndicatorString(
    record.indicatorId ?? record.indicator_id,
    `${path}.indicatorId`,
  );
  const id = optionalIndicatorString(record.id, `${path}.id`);
  const pane = optionalIndicatorString(record.pane, `${path}.pane`);
  const name = optionalIndicatorString(record.name, `${path}.name`);
  const side = optionalIndicatorString(record.side, `${path}.side`);
  const message = optionalIndicatorString(record.message, `${path}.message`);
  if (indicatorId !== undefined) signal.indicatorId = indicatorId;
  if (id !== undefined) signal.id = id;
  if (pane !== undefined) signal.pane = pane;
  if (name !== undefined) signal.name = name;
  if (side !== undefined) signal.side = side;
  if (message !== undefined) signal.message = message;
  return signal;
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
    const label = optionalIndicatorString(record.label, `${itemPath}.label`);
    const type = optionalIndicatorString(record.type, `${itemPath}.type`);
    const min = optionalIndicatorFiniteNumber(record.min, `${itemPath}.min`);
    const max = optionalIndicatorFiniteNumber(record.max, `${itemPath}.max`);
    const step = optionalIndicatorFiniteNumber(record.step, `${itemPath}.step`);
    const fields = {
      ...(label === undefined ? {} : { label }),
      ...(type === undefined ? {} : { type }),
      ...(record.default === undefined ? {} : { default: record.default }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
      ...(record.options !== undefined
        ? {
            options: indicatorStringArray(
              record.options,
              `${itemPath}.options`,
            ),
          }
        : {}),
    };
    if (key) return { ...fields, key, ...(name ? { name } : {}) };
    if (name) return { ...fields, name };
    throw new IndicatorPayloadError(itemPath, "expected key or name");
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
  const revision: IndicatorRevision = {};
  const serverEpoch = optionalIndicatorString(
    record.serverEpoch ?? record.server_epoch,
    `${path}.serverEpoch`,
  );
  const closedThrough = optionalIndicatorFiniteNumber(
    record.closedThrough ?? record.closed_through,
    `${path}.closedThrough`,
  );
  const token = optionalIndicatorString(record.token, `${path}.token`);
  if (serverEpoch !== undefined) revision.serverEpoch = serverEpoch;
  if (correctionRevision !== undefined) {
    revision.correctionRevision = correctionRevision;
  }
  if (closedThrough !== undefined) revision.closedThrough = closedThrough;
  if (token !== undefined) revision.token = token;
  if (dirtyRange !== undefined && dirtyRange !== null) {
    revision.dirtyRange = parseIndicatorRange(dirtyRange, `${path}.dirtyRange`);
  }
  if (historyInvalid === true) revision.historyInvalid = true;
  return revision;
}

function parseIndicatorErrorDetail(
  value: unknown,
  path: string,
): IndicatorErrorDetail {
  const record = expectIndicatorRecord(value, path);
  const detail: IndicatorErrorDetail = {
    message: expectIndicatorNonEmptyString(record.message, `${path}.message`),
  };
  const line = optionalIndicatorFiniteNumber(record.line, `${path}.line`);
  const column = optionalIndicatorFiniteNumber(record.column, `${path}.column`);
  const hint = optionalIndicatorString(record.hint, `${path}.hint`);
  if (line !== undefined) detail.line = line;
  if (column !== undefined) detail.column = column;
  if (hint !== undefined) detail.hint = hint;
  return detail;
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
  const envelope: IndicatorPayloadEnvelope = {
    ok,
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
  };
  const schemaVersion = optionalIndicatorFiniteNumber(
    record.schemaVersion ?? record.schema_version,
    `${path}.schemaVersion`,
  );
  const outputSchemaVersion = optionalIndicatorFiniteNumber(
    record.outputSchemaVersion ?? record.output_schema_version,
    `${path}.outputSchemaVersion`,
  );
  const error = record.error === null
    ? null
    : optionalIndicatorString(record.error, `${path}.error`);
  const code = optionalIndicatorString(record.code, `${path}.code`);
  const httpStatus = optionalIndicatorFiniteNumber(
    record.__httpStatus,
    `${path}.__httpStatus`,
  );
  if (schemaVersion !== undefined) envelope.schemaVersion = schemaVersion;
  if (outputSchemaVersion !== undefined) {
    envelope.outputSchemaVersion = outputSchemaVersion;
  }
  if (error !== undefined) envelope.error = error;
  if (record.detail !== undefined) envelope.detail = record.detail;
  if (code !== undefined) envelope.code = code;
  if (record.errorDetail !== undefined || record.error_detail !== undefined) {
    envelope.errorDetail = parseIndicatorErrorDetail(
      record.errorDetail ?? record.error_detail,
      `${path}.errorDetail`,
    );
  }
  if (range !== undefined && range !== null) {
    envelope.range = parseIndicatorRange(range, `${path}.range`);
  }
  if (revision !== undefined && revision !== null) {
    envelope.dataRevision = parseIndicatorRevision(
      revision,
      `${path}.dataRevision`,
    );
  }
  if (httpStatus !== undefined) envelope.__httpStatus = httpStatus;
  if (record.history_state !== undefined && record.history_state !== null) {
    const historyState = expectIndicatorString(record.history_state, `${path}.history_state`);
    if (historyState !== "ready" && historyState !== "pending" && historyState !== "exhausted") {
      throw new IndicatorPayloadError(
        `${path}.history_state`,
        "expected ready, pending, or exhausted",
      );
    }
    envelope.history_state = historyState;
  }
  const complete = optionalIndicatorBoolean(record.complete, `${path}.complete`);
  const retryable = optionalIndicatorBoolean(record.retryable, `${path}.retryable`);
  if (complete !== undefined) envelope.complete = complete;
  if (retryable !== undefined) envelope.retryable = retryable;
  if (record.terminal_reason !== undefined) {
    envelope.terminal_reason = record.terminal_reason === null
      ? null
      : expectIndicatorString(record.terminal_reason, `${path}.terminal_reason`);
  }
  for (const field of ["earliest_available_ms", "next_before_ms"] as const) {
    if (record[field] === null) {
      envelope[field] = null;
      continue;
    }
    const parsed = optionalIndicatorFiniteNumber(record[field], `${path}.${field}`);
    if (parsed !== undefined) {
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new IndicatorPayloadError(`${path}.${field}`, "expected a non-negative integer or null");
      }
      envelope[field] = parsed;
    }
  }
  if (record.availability_revision !== undefined) {
    envelope.availability_revision = record.availability_revision === null
      ? null
      : expectIndicatorString(record.availability_revision, `${path}.availability_revision`);
  }
  if (record.excluded_ranges !== undefined && record.excluded_ranges !== null) {
    envelope.excluded_ranges = expectIndicatorArray(
      record.excluded_ranges,
      `${path}.excluded_ranges`,
    ).map((item, index) => {
      const itemPath = `${path}.excluded_ranges[${index}]`;
      const excluded = expectIndicatorRecord(item, itemPath);
      const startMs = expectIndicatorFiniteNumber(excluded.start_ms, `${itemPath}.start_ms`);
      const endMs = expectIndicatorFiniteNumber(excluded.end_ms, `${itemPath}.end_ms`);
      if (!Number.isInteger(startMs) || startMs < 0 || !Number.isInteger(endMs) || endMs < startMs) {
        throw new IndicatorPayloadError(itemPath, "expected a valid non-negative start_ms/end_ms range");
      }
      return {
        start_ms: startMs,
        end_ms: endMs,
        ...(excluded.reason == null
          ? {}
          : { reason: expectIndicatorNonEmptyString(excluded.reason, `${itemPath}.reason`) }),
      };
    });
  }
  return envelope;
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
  const customIndicator: CustomIndicatorRecord = {
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
  };
  const normalizedSecurityMode = securityMode === null
    ? null
    : optionalIndicatorString(securityMode, `${path}.securityMode`);
  const language = optionalIndicatorString(record.language, `${path}.language`);
  const createdAt = optionalIndicatorFiniteNumber(
    record.createdAt ?? record.created_at,
    `${path}.createdAt`,
  );
  const updatedAt = optionalIndicatorFiniteNumber(
    record.updatedAt ?? record.updated_at,
    `${path}.updatedAt`,
  );
  if (normalizedSecurityMode !== undefined) {
    customIndicator.securityMode = normalizedSecurityMode;
  }
  if (language !== undefined) customIndicator.language = language;
  if (createdAt !== undefined) customIndicator.createdAt = createdAt;
  if (updatedAt !== undefined) customIndicator.updatedAt = updatedAt;
  return customIndicator;
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

export function parseIndicatorComputeBatchResponse(
  value: unknown,
  path = "indicator.computeBatch",
): IndicatorComputeBatchResponse {
  const record = expectIndicatorRecord(value, path);
  const seenJobKeys = new Set<string>();
  const seenClientIds = new Set<string>();
  const results = expectIndicatorArray(record.results, `${path}.results`).map(
    (item, index) => {
      const itemPath = `${path}.results[${index}]`;
      const result = expectIndicatorRecord(item, itemPath);
      const clientId = expectIndicatorNonEmptyString(
        result.clientId,
        `${itemPath}.clientId`,
      );
      const jobKey = expectIndicatorNonEmptyString(
        result.jobKey,
        `${itemPath}.jobKey`,
      );
      if (seenClientIds.has(clientId)) {
        throw new IndicatorPayloadError(`${itemPath}.clientId`, "expected a unique client id");
      }
      if (seenJobKeys.has(jobKey)) {
        throw new IndicatorPayloadError(`${itemPath}.jobKey`, "expected a unique job key");
      }
      seenClientIds.add(clientId);
      seenJobKeys.add(jobKey);
      return {
        clientId,
        jobKey,
        payload: parseIndicatorPayloadEnvelope(
          result.payload,
          `${itemPath}.payload`,
        ),
      };
    },
  );
  return {
    ok: expectIndicatorBoolean(record.ok, `${path}.ok`),
    results,
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
