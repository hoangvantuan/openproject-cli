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
  let response: Response;
  try {
    response = await fetch(`${instanceUrl}/api/v3/users/me`, {
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

  const user = (await response.json()) as AuthenticatedUser;
  return {
    id: user.id,
    name: user.name,
    login: user.login,
  };
}
