import { OpCliError } from "./errors.js";
import type { RunEnvironment } from "../run.js";

export interface AuthenticatedUser {
  readonly id: number;
  readonly name: string;
  readonly login: string;
}

export async function authenticate(
  instanceUrl: string,
  apiKey: string,
): Promise<AuthenticatedUser> {
  const user = (await apiGet(
    instanceUrl,
    apiKey,
    "/api/v3/users/me",
  )) as AuthenticatedUser;
  return {
    id: user.id,
    name: user.name,
    login: user.login,
  };
}

// Reads may burn exactly one extra attempt on a transient 429/5xx; writes
// never retry (ADR-0002): a replayed create or update can duplicate data.
const READ_RETRY_DELAY_MS = 200;

// The per-attempt budget is a policy of the run environment, not a
// constant: OP_CLI_TIMEOUT_MS names a larger one for slow reads, and an
// unusable value is refused like a bad --limit instead of silently
// falling back.
const DEFAULT_TIMEOUT_MS = 10_000;

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new OpCliError(
      "USAGE_ERROR",
      `OP_CLI_TIMEOUT_MS "${raw}" is not a positive integer.`,
      "pass a whole number of milliseconds, 1 or more.",
    );
  }
  return Number(raw);
}

let timeoutMs = DEFAULT_TIMEOUT_MS;

/**
 * Derive the per-request timeout from the run environment. Called once
 * per run so every request of one session shares one budget.
 */
export function bindRequestTimeout(env: RunEnvironment): void {
  timeoutMs = parseTimeoutMs(env.OP_CLI_TIMEOUT_MS);
}

async function attempt(
  instanceUrl: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Response> {
  // AbortSignal.timeout aborts with a TimeoutError reason. A budget
  // problem (too impatient) and a reachability problem (wrong URL)
  // share the NETWORK_ERROR code and exit 6 by contract; only the
  // wording and machine-readable details tell them apart.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`${instanceUrl}${path}`, {
      headers: {
        accept: "application/hal+json",
        authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}`,
        // The API rejects non-JSON bodies with 415; without this header
        // fetch would label the body text/plain.
        ...(method === "POST" || method === "PATCH"
          ? { "content-type": "application/json" }
          : {}),
      },
      signal,
      ...(method === "POST" || method === "PATCH"
        ? { method, body: JSON.stringify(body) }
        : { method }),
    });
  } catch {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      throw new OpCliError(
        "NETWORK_ERROR",
        `The request exceeded the ${timeoutMs} ms timeout.`,
        "raise OP_CLI_TIMEOUT_MS and try again.",
        { timedOut: true, timeoutMs },
      );
    }
    throw new OpCliError("NETWORK_ERROR");
  }
}

async function request(
  instanceUrl: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Response> {
  let response = await attempt(instanceUrl, apiKey, path, method, body);
  if (method === "GET" && (response.status === 429 || response.status >= 500)) {
    // Promise.withResolvers needs ES2024 lib; the executor form stays.
    await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
    response = await attempt(instanceUrl, apiKey, path, method, body);
  }

  if (response.status === 401 || response.status === 403) {
    throw new OpCliError("AUTH_FAILED");
  }
  return response;
}

async function send(
  instanceUrl: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const response = await request(instanceUrl, apiKey, path, method, body);
  if (response.status === 204) {
    return undefined;
  }
  if (response.status === 404) {
    throw new OpCliError("NOT_FOUND");
  }
  if (!response.ok) {
    throw new OpCliError("API_ERROR");
  }
  return await response.json();
}

/**
 * A write response left unmapped so the proof-carrying retry of ADR-0002
 * can inspect the status and body before the catalogue mapping happens.
 * The caller owns that mapping; only network failures (including timeouts)
 * and authentication errors throw here, because no refresh can repair them.
 */
export interface RawWriteResponse {
  readonly status: number;
  readonly body: unknown | undefined;
}

async function bodyOf(response: Response): Promise<unknown | undefined> {
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {return text;
  }
}

export async function apiPostRaw(
  instanceUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<RawWriteResponse> {
  const response = await request(instanceUrl, apiKey, path, "POST", body);
  return { status: response.status, body: await bodyOf(response) };
}

export async function apiPatchRaw(
  instanceUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<RawWriteResponse> {
  const response = await request(instanceUrl, apiKey, path, "PATCH", body);
  return { status: response.status, body: await bodyOf(response) };
}

export async function apiDelete(
  instanceUrl: string,
  apiKey: string,
  path: string,
): Promise<unknown> {
  return send(instanceUrl, apiKey, path, "DELETE");
}

export async function apiGet(
  instanceUrl: string,
  apiKey: string,
  path: string,
): Promise<unknown> {
  return send(instanceUrl, apiKey, path, "GET");
}

export async function apiPost(
  instanceUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  return send(instanceUrl, apiKey, path, "POST", body);
}
