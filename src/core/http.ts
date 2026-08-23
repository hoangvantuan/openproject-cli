import { OpCliError } from "./errors.js";

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

export async function apiGet(
  instanceUrl: string,
  apiKey: string,
  path: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${instanceUrl}${path}`, {
      headers: {
        accept: "application/hal+json",
        authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OpCliError("NETWORK_ERROR");
  }

  if (response.status === 401 || response.status === 403) {
    throw new OpCliError("AUTH_FAILED");
  }
  if (!response.ok) {
    throw new OpCliError("API_ERROR");
  }
  return await response.json();
}
