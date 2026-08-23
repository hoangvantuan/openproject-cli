import { OpCliError } from "./errors.js";

// The accepted value grammar of --hours, taught verbatim in every refusal.
const ACCEPTED_FORMS =
  "a decimal number of hours such as 1.5, a compound form such as 1h30m, "
    + "or an ISO 8601 duration such as PT1H30M";

/**
 * Parse one ISO 8601 time duration (PT…) into milliseconds, or return
 * undefined when the string is not exactly that grammar. Days, weeks,
 * months, and years are refused on purpose: the hours field of a time
 * entry never carries a calendar component.
 */
function isoToMs(raw: string): number | undefined {
  const match = /^p(?:t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)$/i.exec(
    raw.trim(),
  );
  if (match === null) {
    return undefined;
  }
  // "PT" alone names no amount of time at all; refuse it like any other
  // malformed form rather than reading it as zero.
  if (match[1] === undefined && match[2] === undefined && match[3] === undefined) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

/**
 * Convert an ISO 8601 duration ("PT1H30M", "PT0S") to decimal hours.
 * The inverse of [hoursToIso] within millisecond precision.
 */
export function isoToHours(iso: string): number {
  const ms = isoToMs(iso);
  if (ms === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `"${iso}" is not an ISO 8601 time duration such as PT1H30M or PT0S.`,
    );
  }
  return ms / 3_600_000;
}

/**
 * Convert decimal hours into the canonical ISO 8601 duration OpenProject
 * expects on the wire: the shortest exact H/M/S spelling of the value at
 * millisecond precision, so binary-fraction noise from decimal input can
 * never leak into a request.
 */
export function hoursToIso(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new OpCliError(
      "USAGE_ERROR",
      `cannot render ${String(hours)} hours as a duration.`,
      "hours must be a finite number of 0 or more.",
    );
  }
  let rest = Math.round(hours * 3_600_000);
  const h = Math.floor(rest / 3_600_000);
  rest -= h * 3_600_000;
  const m = Math.floor(rest / 60_000);
  rest -= m * 60_000;
  const s = rest / 1000;
  const parts: Array<string> = [];
  if (h > 0) {
    parts.push(`${String(h)}H`);
  }
  if (m > 0) {
    parts.push(`${String(m)}M`);
  }
  if (s > 0) {
    // Up to three decimals, no trailing zeros: 0.5S stays 0.5S, 27S stays 27S.
    parts.push(`${s.toFixed(3).replace(/\.?0+$/, "")}S`);
  }
  return parts.length === 0 ? "PT0S" : `PT${parts.join("")}`;
}

export interface ParsedDuration {
  /** The amount of time in decimal hours, always greater than zero. */
  readonly hours: number;
  /** The canonical ISO 8601 form sent to the API. */
  readonly iso: string;
}

/**
 * Read one raw `--hours` value: a decimal number of hours ("1.5"), a
 * compound form ("1h30m"), or an ISO 8601 duration ("PT1H30M"). Every
 * accepted spelling of the same amount produces the identical result.
 */
export function parseDuration(raw: string): ParsedDuration {
  const token = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    return parsedFromHours(Number(token), raw);
  }

  const compound = token.toLowerCase().replace(/\s+/g, "");
  // Segments are consumed in whatever units the caller used, but the
  // h → m → s order must hold and no unit may repeat: "45m" is legal,
  // "30m1h" and "1h30h" are refused instead of guessed at. Any
  // unconsumed tail refuses the whole input; NaN marks the refusal.
  const segment = /^(\d+(?:\.\d+)?)([hms])/;
  const UNIT_MS: Readonly<Record<"h" | "m" | "s", number>> = {
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
  };
  let rest = compound;
  let ms = 0;
  let lastIndex = -1;
  while (rest !== "") {
    const match = segment.exec(rest);
    const unitIndex = match === null ? -1 : (["h", "m", "s"] as const).indexOf(match[2] as "h" | "m" | "s");
    if (match === null || unitIndex < 0 || unitIndex <= lastIndex) {
      ms = Number.NaN;
      break;
    }
    lastIndex = unitIndex;
    ms += Number(match[1]) * UNIT_MS[match[2] as "h" | "m" | "s"];
    rest = rest.slice(match[0].length);
  }
  if (!Number.isNaN(ms)) {
    return parsedFromHours(ms / 3_600_000, raw);
  }

  const direct = isoToMs(token);
  if (direct !== undefined) {
    return parsedFromHours(direct / 3_600_000, raw);
  }
  throw new OpCliError(
    "USAGE_ERROR",
    `cannot read "${raw}" as a duration.`,
    `--hours accepts ${ACCEPTED_FORMS}.`,
  );
}

/** Shared tail of parseDuration: positive amounts only. */
function parsedFromHours(hours: number, raw: string): ParsedDuration {
  if (!(hours > 0)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `"${raw}" does not name a positive amount of time.`,
      `--hours accepts ${ACCEPTED_FORMS}, and logging needs more than zero.`,
    );
  }
  return { hours, iso: hoursToIso(hours) };
}
