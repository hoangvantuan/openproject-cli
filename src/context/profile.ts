import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunEnvironment } from "../run.js";
import { OpCliError } from "../core/errors.js";

const DEFAULT_PROFILE = "default";

interface StoredConfig {
  readonly default_profile: string;
  readonly profiles: Record<string, { readonly url: string }>;
}

interface StoredCredentials {
  readonly [profile: string]: { readonly api_key: string };
}

export interface ActiveProfile {
  readonly name: string;
  readonly instanceUrl: string;
  readonly apiKey: string;
}

function configDirectory(env: RunEnvironment): string {
  if (env.OP_CLI_CONFIG_DIR) {
    return env.OP_CLI_CONFIG_DIR;
  }

  const home = env.HOME;
  if (!home) {
    throw new OpCliError("USAGE_ERROR");
  }
  return join(home, ".config", "op-cli");
}

export async function saveDefaultProfile(
  env: RunEnvironment,
  instanceUrl: string,
  apiKey: string,
): Promise<void> {
  const directory = configDirectory(env);
  await mkdir(directory, { recursive: true });

  const config = {
    default_profile: DEFAULT_PROFILE,
    profiles: {
      [DEFAULT_PROFILE]: { url: instanceUrl },
    },
  };
  const credentials = {
    [DEFAULT_PROFILE]: { api_key: apiKey },
  };

  await writeFile(join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(credentialsPath, 0o600);
}

export async function loadDefaultProfile(
  env: RunEnvironment,
): Promise<ActiveProfile> {
  const directory = configDirectory(env);
  let config: StoredConfig;
  let credentials: StoredCredentials;
  try {
    config = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    ) as StoredConfig;
    credentials = JSON.parse(
      await readFile(join(directory, "credentials.json"), "utf8"),
    ) as StoredCredentials;
  } catch {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  const name = config.default_profile;
  const profile = config.profiles[name];
  const secret = credentials[name];
  if (!profile || !secret) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }

  return {
    name,
    instanceUrl: profile.url,
    apiKey: secret.api_key,
  };
}
