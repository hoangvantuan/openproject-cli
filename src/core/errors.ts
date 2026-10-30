export const ERROR_CATALOGUE = {
  USAGE_ERROR: {
    exitCode: 1,
    message: "Invalid command usage.",
    hint: "run op-cli --help.",
  },
  PROFILE_NOT_FOUND: {
    exitCode: 1,
    message: "No active profile.",
    hint: "run op-cli auth login.",
  },
  NOT_FOUND: {
    exitCode: 4,
    message: "Not found.",
    hint: "check the id; run op-cli meta refresh if names changed recently.",
  },
  API_ERROR: {
    exitCode: 2,
    message: "OpenProject request failed.",
    hint: "try again later.",
  },
  INTERNAL_ERROR: {
    exitCode: 2,
    message: "Unexpected failure.",
    hint: "retry or report the error.",
  },
  AUTH_FAILED: {
    exitCode: 3,
    message: "Authentication failed.",
    hint: "run op-cli auth login.",
  },
  // A 403: the credentials are fine, the account lacks a permission, so
  // logging in again cannot help.
  PERMISSION_DENIED: {
    exitCode: 8,
    message: "Permission denied.",
    hint: "ask an administrator for the missing permission, or use an account that has it.",
  },
  UNSUPPORTED_VERSION: {
    exitCode: 7,
    message: "The instance version is not supported.",
    hint: "OpenProject v13 with API v3 or newer is required.",
  },
  CONFLICT: {
    exitCode: 5,
    message: "The work package was modified while the update ran.",
    hint: "read the current values, merge them with your change, and repeat.",
  },
  NETWORK_ERROR: {
    exitCode: 6,
    message: "Could not reach the instance.",
    hint: "check the instance URL and try again.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export class OpCliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly hint: string;
  /** Extra machine-readable facts merged into JSON error output. */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  // The code stays inside the closed catalogue; only the wording is
  // contextual, so scripts matching on codes keep their promise.
  constructor(code: ErrorCode, message?: string, hint?: string,
    details?: Readonly<Record<string, unknown>>) {
    const definition = ERROR_CATALOGUE[code];
    super(message ?? definition.message);
    this.name = "OpCliError";
    this.code = code;
    this.exitCode = definition.exitCode;
    this.hint = hint ?? definition.hint;
    this.details = details;
  }
}

/**
 * Refuse flags that exclude one another: each entry is the flag's spelling
 * when it was given and undefined when it was not. More than one given is
 * a USAGE_ERROR naming them, so a mutual-exclusion rule is one call and
 * one wording wherever it applies.
 */
export function refuseCombined(
  given: ReadonlyArray<string | undefined>,
  hint: string,
): void {
  const flags = given.filter((flag): flag is string => flag !== undefined);
  if (flags.length > 1) {
    throw new OpCliError("USAGE_ERROR", `${flags.join(" and ")} cannot be combined.`, hint);
  }
}

/** OpenProject's own explanation of a refusal, when the body carries one. */
export function explanationOf(body: unknown): string | undefined {
  const message = typeof body === "object" && body !== null
    ? (body as Record<string, unknown>).message
    : undefined;
  return typeof message === "string" ? message : undefined;
}

/**
 * The catalogue entry for a write the instance refused. A refusal is not
 * an outage: the same request will be refused the same way until the
 * values change, so it must not borrow the "try again later" hint that
 * belongs to an unreachable or overloaded instance. The one exception is
 * 429, where waiting is exactly the repair.
 */
export function writeRefusal(
  subject: string,
  status: number,
  body: unknown,
): OpCliError {
  const explanation = explanationOf(body);
  const message = `OpenProject rejected the ${subject}`
    + (explanation === undefined ? "." : `: ${explanation}`);
  if (status === 429) {
    return new OpCliError("API_ERROR", message);
  }
  return new OpCliError(
    "API_ERROR",
    message,
    "fix the rejected values and repeat the command.",
  );
}

/** How one kind of write words its refusals and its unknown outcomes. */
export interface WriteWording {
  /** The write as a noun: "create", "update", "upload", "comment". */
  readonly action: string;
  /** What is not known after a 5xx or an unfinished request. */
  readonly unknown: string;
  /** What to run before repeating the command. */
  readonly check: string;
}

/**
 * The catalogue entry for a write that did not succeed, shared by every
 * command that writes (ADR-0002): 404 is NOT_FOUND, a 5xx is the
 * unknown-state NETWORK_ERROR because the request may still have been
 * applied (never a retry that could write twice), and anything else is a
 * refusal that quotes the instance's own explanation.
 */
export function writeFailure(
  status: number,
  body: unknown,
  wording: WriteWording,
): OpCliError {
  if (status === 404) {
    return new OpCliError("NOT_FOUND");
  }
  if (status >= 500) {
    return new OpCliError(
      "NETWORK_ERROR",
      `the ${wording.action} failed with HTTP ${String(status)}; ${wording.unknown}.`,
      wording.check,
    );
  }
  return writeRefusal(wording.action, status, body);
}

/**
 * Runs a write whose request may never complete: timeouts and network
 * errors are never retried on writes, and exit 6 says the outcome is
 * unknown instead of inviting a duplicate.
 */
export async function unknownIfUnfinished<T>(
  attempt: () => Promise<T>,
  wording: WriteWording,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        `the ${wording.action} request did not complete; ${wording.unknown}.`,
        wording.check,
      );
    }
    throw error;
  }
}

export function renderTextError(error: OpCliError): string {
  return `[${error.code}] ${error.message} Hint: ${error.hint}\n`;
}

export function renderJsonError(error: OpCliError): string {
  return `${JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...(error.details ?? {}),
    },
  })}\n`;
}

