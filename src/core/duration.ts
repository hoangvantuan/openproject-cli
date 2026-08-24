import { OpCliError } from "./errors.js";

// The accepted value grammar of --hours, taught verbatim in every refusal.
const ACCEPTED_FORMS =
  "a decimal number of hours such as 1.5, a compound form such as 1h30m, "
    + "or an ISO 8601 duration such as PT1H30M";

// Every fixed-length ISO 8601 component, in the order the grammar spells
// them: weeks and days before the T, hours, minutes, and seconds after it.
// Years and months are absent on purpose: they name calendar spans of no
// fixed number of hours, so no value can be read out of them.
const ISO_DURATION =
  /^p(?:(\d+(?:\.\d+)?)w)?(?:(\d+(?:\.\d+)?)d)?(t(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?)?$/i;

/**
 * Parse any fixed-length ISO 8601 duration into milliseconds, or return
 * undefined when the string is not that grammar. This is the read path:
 * OpenProject spells a duration of 24 hours or more with a day component
 * ("P3DT1H") and a week component beyond that, so everything the instance
 * can emit has to be readable here.
 */
function isoDurationToMs(raw: string): number | undefined {
  const match = ISO_DURATION.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  // Each matched component, paired with the seconds one unit of it is worth.
  const dateComponents = [[match[1], 604_800], [match[2], 86_400]] as const;
  const timeComponents = [[match[4], 3_600], [match[5], 60], [match[6], 1]] as const;
  const components = [...dateComponents, ...timeComponents];
  const missing = ([component]: readonly [string | undefined, number]): boolean =>
    component === undefined;
  // "P" and "PT" name no amount of time at all, and a "T" carrying nothing
  // after it is half a form; refuse them like any other malformed input
  // rather than reading a gap as zero. match[3] is the whole T section when
  // one was written, so its presence beside no H, M, or S is that bare "T".
  if (components.every(missing)) {
    return undefined;
  }
  if (match[3] !== undefined && timeComponents.every(missing)) {
    return undefined;
  }
  const seconds = components.reduce(
    (carry, [component, perUnit]) => carry + Number(component ?? 0) * perUnit,
    0,
  );
  return Math.round(seconds * 1000);
}

/**
 * Parse one ISO 8601 time-only duration (PT…) into milliseconds, or return
 * undefined when the string is not exactly that grammar. Weeks and days
 * are refused on purpose: this is the write path, and the hours field of
 * a single time entry never carries a calendar component.
 *
 * The narrowing rides on the shape of ISO_DURATION, where the week and day
 * components can only ever precede the "T": a value that starts "PT" has
 * none of them. Keep that ordering if the shared grammar is ever rewritten.
 */
function isoTimeToMs(raw: string): number | undefined {
  const token = raw.trim();
  return /^pt/i.test(token) ? isoDurationToMs(token) : undefined;
}

/**
 * Convert an ISO 8601 duration the instance reported ("PT1H30M", "PT0S",
 * "P3DT1H") to decimal hours. The inverse of [hoursToIso] within
 * millisecond precision for every value [hoursToIso] can render.
 *
 * The value read here was never typed by the caller, so a duration this
 * client cannot read is the instance's answer failing, not misuse.
 */
export function isoToHours(iso: string): number {
  const ms = isoDurationToMs(iso);
  if (ms === undefined) {
    throw new OpCliError(
      "API_ERROR",
      `the instance reported the duration "${iso}", which is not an ISO 8601 `
        + "duration such as PT1H30M, PT0S, or P3DT1H.",
      "durations in weeks, days, hours, minutes, or seconds can be read; "
        + "report the value if the instance keeps sending it.",
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

  const direct = isoTimeToMs(token);
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
