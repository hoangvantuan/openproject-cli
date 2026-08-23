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
  UNSUPPORTED_VERSION: {
    exitCode: 4,
    message: "The instance version is not supported.",
    hint: "OpenProject v13 with API v3 or newer is required.",
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

  constructor(code: ErrorCode) {
    const definition = ERROR_CATALOGUE[code];
    super(definition.message);
    this.name = "OpCliError";
    this.code = code;
    this.exitCode = definition.exitCode;
    this.hint = definition.hint;
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
    },
  })}\n`;
}
