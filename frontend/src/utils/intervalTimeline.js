function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeTimeMagnitude(value) {
  return finiteNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function calendarMonthInterval(value) {
  if (typeof value !== "string") return { matched: false, months: null };
  const normalized = value.trim();
  if (!normalized.endsWith("M")) return { matched: false, months: null };
  const match = /^([1-9]\d*)M$/.exec(normalized);
  if (!match) return { matched: true, months: null };
  const months = Number(match[1]);
  return {
    matched: true,
    months: Number.isSafeInteger(months) ? months : null,
  };
}

function utcDateParts(time) {
  if (!safeTimeMagnitude(time)) return null;
  const milliseconds = time * 1_000;
  if (!finiteNumber(milliseconds)) return null;
  const date = new Date(milliseconds);
  const clippedMilliseconds = date.getTime();
  if (!finiteNumber(clippedMilliseconds)) return null;
  return {
    date,
    subMillisecond: milliseconds - clippedMilliseconds,
  };
}

export function addUtcCalendarMonths(time, months) {
  if (!Number.isSafeInteger(months) || months < 0) return null;
  const source = utcDateParts(time);
  if (!source) return null;

  const day = source.date.getUTCDate();
  const target = new Date(source.date.getTime());
  target.setUTCDate(1);
  target.setUTCFullYear(
    target.getUTCFullYear(),
    target.getUTCMonth() + months,
    1,
  );
  if (!finiteNumber(target.getTime())) return null;

  const lastDay = new Date(target.getTime());
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  if (!finiteNumber(lastDay.getTime())) return null;
  target.setUTCDate(Math.min(day, lastDay.getUTCDate()));

  const result = (target.getTime() + source.subMillisecond) / 1_000;
  return safeTimeMagnitude(result) ? result : null;
}

function calendarBoundaryTime(horizon, monthsPerCell, cell) {
  if (!Number.isSafeInteger(monthsPerCell)
    || monthsPerCell < 1
    || !Number.isSafeInteger(cell)
    || cell < 0) {
    return null;
  }
  const monthOffset = monthsPerCell * cell;
  return Number.isSafeInteger(monthOffset)
    ? addUtcCalendarMonths(horizon, monthOffset)
    : null;
}

function calendarFutureTime(horizon, monthsPerCell, cellDistance) {
  if (!finiteNumber(cellDistance) || cellDistance <= 0) return null;
  const wholeCells = Math.floor(cellDistance);
  if (!Number.isSafeInteger(wholeCells) || wholeCells < 0) return null;
  const lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
  if (lower === null) return null;

  const fraction = cellDistance - wholeCells;
  if (fraction === 0) return lower;
  const upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
  if (upper === null || upper <= lower) return null;
  const time = lower + (upper - lower) * fraction;
  return safeTimeMagnitude(time) ? time : null;
}

function calendarFutureCellDistance(horizon, monthsPerCell, time) {
  if (!safeTimeMagnitude(time) || time <= horizon) return null;
  const start = utcDateParts(horizon);
  const target = utcDateParts(time);
  if (!start || !target) return null;

  const monthDelta = (target.date.getUTCFullYear() - start.date.getUTCFullYear()) * 12
    + target.date.getUTCMonth() - start.date.getUTCMonth();
  if (!Number.isSafeInteger(monthDelta)) return null;
  let wholeCells = Math.max(0, Math.floor(monthDelta / monthsPerCell));
  let lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
  if (lower === null) return null;

  if (lower > time && wholeCells > 0) {
    wholeCells -= 1;
    lower = calendarBoundaryTime(horizon, monthsPerCell, wholeCells);
    if (lower === null) return null;
  }
  let upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
  if (upper === null) return null;
  if (upper <= time) {
    wholeCells += 1;
    lower = upper;
    upper = calendarBoundaryTime(horizon, monthsPerCell, wholeCells + 1);
    if (upper === null) return null;
  }
  if (lower > time || upper <= lower || time >= upper) return null;

  const fraction = (time - lower) / (upper - lower);
  const distance = wholeCells + fraction;
  return finiteNumber(distance) && distance > 0 ? distance : null;
}

export function createFutureIntervalBasis({
  horizon,
  sourceInterval,
  sourceIntervalSeconds,
} = {}) {
  if (!safeTimeMagnitude(horizon)) return null;
  const calendarInterval = calendarMonthInterval(sourceInterval);
  const step = Number(sourceIntervalSeconds);
  if ((calendarInterval.matched && calendarInterval.months === null)
    || (!calendarInterval.matched && (!finiteNumber(step) || step <= 0))) {
    return null;
  }
  return {
    calendarMonths: calendarInterval.months,
    horizon,
    step,
  };
}

export function futureTimeFromIntervalDistance(basis, cellDistance) {
  if (!basis || !finiteNumber(cellDistance) || cellDistance <= 0) return null;
  if (basis.calendarMonths !== null) {
    return calendarFutureTime(basis.horizon, basis.calendarMonths, cellDistance);
  }
  const time = basis.horizon + cellDistance * basis.step;
  return safeTimeMagnitude(time) ? time : null;
}

export function futureIntervalDistanceFromTime(basis, time) {
  if (!basis) return null;
  if (basis.calendarMonths !== null) {
    return calendarFutureCellDistance(basis.horizon, basis.calendarMonths, time);
  }
  const distance = (time - basis.horizon) / basis.step;
  return finiteNumber(distance) && distance > 0 ? distance : null;
}
