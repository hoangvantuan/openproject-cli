import { OpCliError } from "./errors.js";
import { parseDuration } from "./duration.js";

/**
 * The raw, still-unvalidated values of the built-in scalar attributes,
 * exactly as typed on a flag or given under a stdin key. `""` means
 * "clear" on update and is refused on create.
 */
export interface ScalarFlags {
  readonly start?: string;
  readonly due?: string;
  readonly estimate?: string;
  readonly remaining?: string;
  readonly done?: string;
  readonly storyPoints?: string;
}

/** Flag name, payload key, and reader of every scalar attribute. */
const SCALARS: ReadonlyArray<{
  readonly option: keyof ScalarFlags;
  readonly flag: string;
  readonly attribute: string;
  readonly read: (raw: string, flag: string) => unknown;
}> = [
  { option: "start", flag: "--start", attribute: "startDate", read: readDate },
  { option: "due", flag: "--due", attribute: "dueDate", read: readDate },
  { option: "estimate", flag: "--estimate", attribute: "estimatedTime", read: readDuration },
  { option: "remaining", flag: "--remaining", attribute: "remainingTime", read: readDuration },
  { option: "done", flag: "--done", attribute: "percentageDone", read: readPercent },
  { option: "storyPoints", flag: "--story-points", attribute: "storyPoints", read: readPoints },
];

/** The option names, for callers that must loop over them. */
export const SCALAR_OPTIONS: ReadonlyArray<keyof ScalarFlags> = SCALARS.map(
  (scalar) => scalar.option,
);

/** The flag spelling of one scalar option, for error messages. */
export function scalarFlag(option: keyof ScalarFlags): string {
  return SCALARS.find((scalar) => scalar.option === option)?.flag ?? option;
}

function readDate(raw: string, flag: string): string {
  const token = raw.trim();
  const real = /^\d{4}-\d{2}-\d{2}$/.test(token) && (() => {
    const [year, month, day] = token.split("-").map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(year, month - 1, day));
    return probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month - 1
      && probe.getUTCDate() === day;
  })();
  if (!real) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${flag} "${raw}" is not a real YYYY-MM-DD date.`,
      `give a calendar date such as 2026-03-31, or "" to clear on update.`,
    );
  }
  return token;
}

function readDuration(raw: string, flag: string): string {
  return parseDuration(raw, { flag, allowZero: true }).iso;
}

function readInteger(raw: string, flag: string, max: number | undefined): number {
  const token = raw.trim();
  const value = /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isSafeInteger(value) || (max !== undefined && value > max)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${flag} "${raw}" is not ${max === undefined ? "a non-negative integer" : `an integer from 0 to ${String(max)}`}.`,
      `give ${max === undefined ? "a whole number of 0 or more" : `a whole number from 0 to ${String(max)}`}, or "" to clear on update.`,
    );
  }
  return value;
}

function readPercent(raw: string, flag: string): number {
  return readInteger(raw, flag, 100);
}

function readPoints(raw: string, flag: string): number {
  return readInteger(raw, flag, undefined);
}

/**
 * Refuse any given scalar that is not well formed, without building a
 * payload. An empty value is a clear request, valid here; whether it is
 * allowed is decided earlier (refuseEmptyValues).
 */
export function validateScalars(flags: ScalarFlags): void {
  for (const scalar of SCALARS) {
    const raw = flags[scalar.option];
    if (raw !== undefined && raw !== "") {
      scalar.read(raw, scalar.flag);
    }
  }
}

/**
 * Validate every given scalar and write it into the payload's top-level
 * attributes: dates as YYYY-MM-DD, durations as ISO 8601, integers as
 * numbers. An empty value writes null, which is how the API clears a
 * scalar; whether that is allowed is decided earlier (refuseEmptyValues).
 */
export function applyScalars(
  payload: Record<string, unknown>,
  flags: ScalarFlags,
): void {
  for (const scalar of SCALARS) {
    const raw = flags[scalar.option];
    if (raw === undefined) {
      continue;
    }
    payload[scalar.attribute] = raw === "" ? null : scalar.read(raw, scalar.flag);
  }
}
