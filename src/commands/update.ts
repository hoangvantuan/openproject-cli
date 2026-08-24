import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { configDirectory } from "../context/profile.js";
import { OpCliError } from "../core/errors.js";
import type { RunEnvironment, RunIo } from "../run.js";

import { cliVersion } from "./version.js";

const PACKAGE_SPEC = "@tuanhv/op-cli@latest";
// Scoped package names must escape the slash for a registry path segment.
const REGISTRY_URL = "https://registry.npmjs.org/@tuanhv%2Fop-cli/latest";

// The notice is a convenience, never a delay: its lookup gets a budget far
// below the API's own, and every failure path stays silent.
const NOTICE_TIMEOUT_MS = 1_500;
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateRuntime {
  readonly env: RunEnvironment;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  /** Forces the process exit code when the installer itself fails. */
  readonly setExitCode: (code: number) => void;
  /** Runs a command with the CLI's own streams; resolves its exit code. */
  readonly runExternal?: (file: string, args: readonly string[]) => Promise<number>;
  /** Runs a command and captures stdout; undefined on any failure. */
  readonly captureExternal?: (
    file: string,
    args: readonly string[],
  ) => Promise<string | undefined>;
}

function isHomebrewPath(path: string): boolean {
  // `npm prefix -g` reports the bare prefix ("/opt/homebrew"), while a
  // resolved binary lands deeper ("/opt/homebrew/bin/op-cli"); the
  // substring catches both without claiming plain /usr/local, which a
  // stock Node install shares with Intel Homebrew.
  return path.includes("/opt/homebrew")
    || path.includes("/Cellar/")
    || path.includes("/usr/local/Homebrew");
}

// An install another manager owns would be overwritten by npm today and
// reverted by that manager's next upgrade, so the exact command is printed
// for the human to run instead. Detection is heuristic on purpose: npm's
// global prefix and the resolved binary path name their manager plainly.
async function detectManagingInstall(
  runtime: UpdateRuntime,
): Promise<{ label: string; command: string } | undefined> {
  const capture = runtime.captureExternal;
  if (capture === undefined) {
    return undefined;
  }
  const prefix = (await capture("npm", ["prefix", "-g"]))?.trim() ?? "";
  if (prefix.includes("volta")) {
    return { label: "Volta", command: `volta install ${PACKAGE_SPEC}` };
  }
  if (isHomebrewPath(prefix)) {
    return { label: "Homebrew", command: "brew upgrade op-cli" };
  }
  const bin = (await capture("which", ["op-cli"]))?.trim() ?? "";
  if (bin.includes("volta")) {
    return { label: "Volta", command: `volta install ${PACKAGE_SPEC}` };
  }
  if (isHomebrewPath(bin)) {
    return { label: "Homebrew", command: "brew upgrade op-cli" };
  }
  return undefined;
}

export function registerUpdateCommand(parent: Command, runtime: UpdateRuntime): void {
  parent.action(async () => {
    const managed = await detectManagingInstall(runtime);
    if (managed !== undefined) {
      runtime.write(
        `${managed.label} manages this install. Run instead:\n  ${managed.command}\n`,
      );
      return;
    }
    if (runtime.runExternal === undefined) {
      throw new OpCliError("INTERNAL_ERROR");
    }
    const code = await runtime.runExternal("npm", ["install", "-g", PACKAGE_SPEC]);
    if (code !== 0) {
      runtime.writeErr(`The installer exited with code ${code}.\n`);
      runtime.setExitCode(code);
    }
  });
}

interface NoticeCache {
  readonly checkedAt: number;
  readonly latest: string;
}

function noticeCachePath(env: RunEnvironment): string | undefined {
  const directory = configDirectory(env);
  return directory === undefined ? undefined : join(directory, "update-check.json");
}

async function readNoticeCache(env: RunEnvironment): Promise<NoticeCache | undefined> {
  const path = noticeCachePath(env);
  if (path === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      readonly checkedAt?: unknown;
      readonly latest?: unknown;
    };
    return typeof parsed.checkedAt === "number" && typeof parsed.latest === "string"
      ? { checkedAt: parsed.checkedAt, latest: parsed.latest }
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeNoticeCache(env: RunEnvironment, cache: NoticeCache): Promise<void> {
  const path = noticeCachePath(env);
  if (path === undefined) {
    return;
  }
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A read-only config directory must never fail the command over a hint.
  }
}

async function fetchLatestRelease(): Promise<string | undefined> {
  try {
    const response = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json() as { readonly version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    // Unreachable registry means no notice, not an error.
    return undefined;
  }
}

function releaseSegments(version: string): ReadonlyArray<number> | undefined {
  const core = version.split("+")[0]?.split("-")[0];
  const parts = core?.split(".") ?? [];
  const segments: Array<number> = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }
    segments.push(Number(part));
  }
  return segments.length > 0 ? segments : undefined;
}

// Only a numerically newer release is news; anything else (older, equal,
// or unparsable) stays quiet so the notice never cries wolf.
function isNewerRelease(latest: string, running: string): boolean {
  const candidate = releaseSegments(latest);
  const current = releaseSegments(running);
  if (candidate === undefined || current === undefined) {
    return false;
  }
  const depth = Math.max(candidate.length, current.length);
  for (let index = 0; index < depth; index += 1) {
    const left = candidate[index] ?? 0;
    const right = current[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
}

async function resolveNoticeLine(env: RunEnvironment): Promise<string | undefined> {
  const running = await cliVersion();
  if (running === "unknown") {
    return undefined;
  }
  const now = Date.now();
  let latest: string | undefined;
  const cached = await readNoticeCache(env);
  if (cached !== undefined && now - cached.checkedAt < NOTICE_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatestRelease();
    if (latest !== undefined) {
      // Only a successful lookup refreshes the stamp: an unreachable
      // registry retries on the next command instead of waiting a day.
      await writeNoticeCache(env, { checkedAt: now, latest });
    }
  }
  if (latest === undefined || !isNewerRelease(latest, running)) {
    return undefined;
  }
  return `op-cli ${latest} available (running ${running}); run op-cli update\n`;
}

// Commands whose own story already answers "which version": the notice
// would only repeat them, and --version must stay offline by contract.
const NOTICE_EXEMPT = ["update", "--version", "--help", "-h"];

/**
 * Starts the new-version notice and resolves with its single stderr line,
 * or undefined when now is not the time for one. Gating is the contract
 * from issue #38: scripted use (stderr not a TTY) never pays for a lookup,
 * OP_CLI_NO_UPDATE_CHECK=1 opts out entirely, and every failure inside
 * stays silent. The promise never rejects.
 */
export function startVersionNotice(
  argv: readonly string[],
  env: RunEnvironment,
  io: Pick<RunIo, "stderrIsTTY">,
): Promise<string | undefined> {
  if (env.OP_CLI_NO_UPDATE_CHECK === "1") {
    return Promise.resolve(undefined);
  }
  if (io.stderrIsTTY !== true) {
    return Promise.resolve(undefined);
  }
  if (NOTICE_EXEMPT.includes(argv[0] ?? "")) {
    return Promise.resolve(undefined);
  }
  return resolveNoticeLine(env);
}
