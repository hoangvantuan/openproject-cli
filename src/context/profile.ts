import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunEnvironment } from "../run.js";
import { OpCliError } from "../core/errors.js";

export const LOGIN_PROFILE = "default";

interface StoredConfig {
  readonly default_profile?: string;
  readonly active_profile?: string;
  readonly profiles: Readonly<Record<string, StoredProfileEntry>>;
}

interface StoredProfileEntry {
  readonly url: string;
  readonly project?: number;
}

interface StoredCredentials {
  [profile: string]: { readonly api_key: string };
}

interface StoredState {
  readonly config: StoredConfig;
  readonly credentials: StoredCredentials;
}

export interface ActiveProfile {
  readonly name: string;
  readonly instanceUrl: string;
  readonly apiKey: string;
  readonly project: number | undefined;
}

export interface ProfileSummary {
  readonly name: string;
  readonly instanceUrl: string;
  readonly project: number | undefined;
}

export interface ProfileListResult {
  readonly activeName: string | undefined;
  readonly profiles: readonly ProfileSummary[];
}

function writableConfigDirectory(env: RunEnvironment): string {
  if (env.OP_CLI_CONFIG_DIR) {
    return env.OP_CLI_CONFIG_DIR;
  }
  const home = env.HOME;
  if (!home) {
    throw new OpCliError("USAGE_ERROR");
  }
  return join(home, ".config", "op-cli");
}

async function readStored(env: RunEnvironment): Promise<StoredState | undefined> {
  const directory =
    env.OP_CLI_CONFIG_DIR ??
    (env.HOME !== undefined ? join(env.HOME, ".config", "op-cli") : undefined);
  if (directory === undefined) {
    return undefined;
  }
  try {
    const config = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    ) as StoredConfig;
    let credentials: StoredCredentials = {};
    try {
      credentials = JSON.parse(
        await readFile(join(directory, "credentials.json"), "utf8"),
      ) as StoredCredentials;
    } catch {
      // Credentials are optional when only the profile identity is needed,
      // e.g. --version reading cached metadata without an API key.
    }
    return { config, credentials };
  } catch {
    return undefined;
  }
}

async function writeStored(
  env: RunEnvironment,
  parts: {
    readonly config?: StoredConfig;
    readonly credentials?: StoredCredentials;
  },
): Promise<void> {
  const directory = writableConfigDirectory(env);
  await mkdir(directory, { recursive: true });

  if (parts.config) {
    await writeFile(
      join(directory, "config.json"),
      `${JSON.stringify(parts.config, null, 2)}\n`,
    );
  }
  if (!parts.credentials) {
    return;
  }
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, `${JSON.stringify(parts.credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(credentialsPath, 0o600);
}

export async function saveProfile(
  env: RunEnvironment,
  instanceUrl: string,
  apiKey: string,
  name: string = LOGIN_PROFILE,
  project?: number,
): Promise<void> {
  const state = await readStored(env);
  const profiles: Record<string, StoredProfileEntry> = {
    ...state?.config.profiles,
    [name]:
      project === undefined
        ? { url: instanceUrl }
        : { url: instanceUrl, project },
  };
  const credentials: StoredCredentials = {
    ...state?.credentials,
    [name]: { api_key: apiKey },
  };

  const config: {
    default_profile?: string;
    active_profile?: string;
    profiles: Record<string, StoredProfileEntry>;
  } = { profiles };
  // Only the first login ever claims default+active; logging into another
  // profile merges alongside instead of stealing the selection.
  config.default_profile =
    state?.config.default_profile ?? name;
  config.active_profile = state?.config.active_profile ?? name;

  await writeStored(env, { config, credentials });
}

function storedSelectedName(state: StoredState): string | undefined {
  const { config } = state;
  if (config.active_profile && config.profiles[config.active_profile]) {
    return config.active_profile;
  }
  if (config.default_profile && config.profiles[config.default_profile]) {
    return config.default_profile;
  }
  return undefined;
}

export async function listProfiles(env: RunEnvironment): Promise<ProfileListResult> {
  const state = await readStored(env);
  if (!state) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  const profiles = Object.entries(state.config.profiles ?? {}).map(
    ([name, entry]): ProfileSummary => ({
      name,
      instanceUrl: entry.url.replace(/\/+$/, ""),
      project: entry.project,
    }),
  );
  return { activeName: storedSelectedName(state), profiles };
}

export async function setActiveProfile(
  env: RunEnvironment,
  name: string,
  options: { readonly project?: number | undefined } = {},
): Promise<void> {
  const state = await readStored(env);
  if (!state || !state.config.profiles[name]) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  const profiles: Record<string, StoredProfileEntry> = {
    ...state.config.profiles,
  };
  const entry = state.config.profiles[name];
  if (options.project !== undefined && entry !== undefined) {
    profiles[name] = { ...entry, project: options.project };
  }
  const config: {
    default_profile?: string;
    active_profile?: string;
    profiles: Readonly<Record<string, StoredProfileEntry>>;
  } = { active_profile: name, profiles };
  if (state.config.default_profile !== undefined) {
    config.default_profile = state.config.default_profile;
  }
  await writeStored(env, { config });
}

export async function requireStoredName(env: RunEnvironment): Promise<string> {
  const state = await readStored(env);
  const name = state ? storedSelectedName(state) : undefined;
  if (!name) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  return name;
}

export async function removeProfile(
  env: RunEnvironment,
  name: string,
): Promise<void> {
  const state = await readStored(env);
  if (!state || !(state.config.profiles[name] || state.credentials[name])) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  const credentials: StoredCredentials = { ...state.credentials };
  delete credentials[name];

  await writeStored(env, { credentials });
}

export const ENV_PROFILE_NAME = "env";

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function parseOptionalId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new OpCliError("USAGE_ERROR");
  }
  return value;
}

export interface ContextOverrides {
  readonly profile?: string | undefined;
  readonly project?: number | undefined;
}

export async function resolveProfile(
  env: RunEnvironment,
  overrides: ContextOverrides = {},
): Promise<ActiveProfile> {
  const state = await readStored(env);
  const explicitName = firstDefined(overrides.profile, env.OP_CLI_PROFILE);
  if (
    explicitName !== undefined &&
    state !== undefined &&
    !state.config.profiles[explicitName]
  ) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  const storedName = state ? storedSelectedName(state) : undefined;
  const name = explicitName ?? storedName;
  const entry = name !== undefined ? state?.config.profiles[name] : undefined;
  const secret =
    name !== undefined ? state?.credentials[name]?.api_key : undefined;

  const instanceUrl = firstDefined(
    env.OPENPROJECT_URL,
    entry?.url,
  )?.replace(/\/+$/, "");
  const apiKey = firstDefined(env.OPENPROJECT_API_KEY, secret);
  if (!instanceUrl) {
    throw new OpCliError("PROFILE_NOT_FOUND");
  }
  if (!apiKey) {
    throw new OpCliError("AUTH_FAILED");
  }

  const displayName = entry !== undefined && name !== undefined
    ? name
    : ENV_PROFILE_NAME;
  return {
    name: displayName,
    instanceUrl,
    apiKey,
    project:
      overrides.project ??
      parseOptionalId(env.OP_CLI_PROJECT) ??
      entry?.project,
  };
}

export interface ProfilePeek {
  readonly name: string;
  readonly instanceUrl: string;
}

// Resolves the active profile identity without requiring credentials, for
// read-only commands such as --version that must run without an API key.
export async function peekActiveProfile(
  env: RunEnvironment,
): Promise<ProfilePeek | undefined> {
  const state = await readStored(env);
  const explicitName = env.OP_CLI_PROFILE;
  const storedName = state ? storedSelectedName(state) : undefined;
  const name = explicitName ?? storedName;
  const entry = name !== undefined ? state?.config.profiles[name] : undefined;
  const instanceUrl = firstDefined(
    env.OPENPROJECT_URL,
    entry?.url,
  )?.replace(/\/+$/, "");
  if (!instanceUrl) {
    return undefined;
  }
  return {
    name: entry !== undefined && name !== undefined ? name : ENV_PROFILE_NAME,
    instanceUrl,
  };
}
