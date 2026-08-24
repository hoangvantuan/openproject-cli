import type { Command } from "commander";

import type { ActiveProfile, ContextOverrides } from "../context/profile.js";
import { OpCliError, type ErrorCode } from "../core/errors.js";
import { apiGet, authenticate } from "../core/http.js";
import { renderTable } from "../output/table.js";

export interface DoctorRuntime {
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

type CheckStatus = "pass" | "warn" | "fail" | "skipped";

interface CheckResult {
  readonly check: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

// The CLI speaks OpenProject API v3; the documented minimum core release is
// v13 (PLAN.md row "Phiên bản OpenProject cũ"). An instance older than v13
// still works partially, so it only warns; a non-v3 API cannot work at all,
// so it fails with its own catalogue code.
const MINIMUM_CORE_MAJOR = 13;

interface RootInfo {
  readonly apiVersion: string | null;
  readonly coreVersion: string | null;
}

function toRootInfo(root: unknown): RootInfo {
  const element = typeof root === "object" && root !== null
    ? root as { readonly [key: string]: unknown }
    : {};
  return {
    apiVersion: typeof element.apiVersion === "string" ? element.apiVersion : null,
    coreVersion: typeof element.coreVersion === "string" ? element.coreVersion : null,
  };
}

function majorOf(version: string): number | undefined {
  const match = /^(\d+)/.exec(version.trim());
  const major = match?.[1];
  return major === undefined ? undefined : Number.parseInt(major, 10);
}

function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof OpCliError ? error.code : "INTERNAL_ERROR";
}

function versionSummary(info: RootInfo): string {
  if (info.apiVersion === null && info.coreVersion === null) {
    return "reported neither version; the root document is optional, so core 13+ may still be running";
  }
  if (info.apiVersion === null) {
    return `core ${info.coreVersion ?? "unknown"}; api version not reported, core 13+ is what the check reads`;
  }
  return `api ${info.apiVersion}, core ${info.coreVersion ?? "unknown"}`;
}

export function registerDoctorCommand(parent: Command, runtime: DoctorRuntime): void {
  parent
    .description("Diagnose connectivity, credentials, permissions, and versions")
    .option("--json", "emit a JSON object")
    .option("--profile <name>", "diagnose this profile instead of the active one")
    .action(async (options: { json?: boolean; profile?: string }) => {
      runtime.setJsonMode(options.json === true);
      const profile = await runtime.resolve({ profile: options.profile });

      const checks: Array<CheckResult> = [];
      let failureCode: ErrorCode | undefined;
      const recordFailure = (check: string, detail: string, code: ErrorCode): void => {
        checks.push({ check, status: "fail", detail });
        failureCode = failureCode ?? code;
      };
      const skip = (name: string): void => {
        checks.push({
          check: name,
          status: "skipped",
          detail: "not attempted: an earlier check failed",
        });
      };

      let info: RootInfo = { apiVersion: null, coreVersion: null };
      try {
        info = toRootInfo(await apiGet(profile.instanceUrl, profile.apiKey, "/api/v3/"));
        checks.push({
          check: "connectivity",
          status: "pass",
          detail: `reached ${profile.instanceUrl}`,
        });
      } catch (error) {
        recordFailure(
          "connectivity",
          `could not reach ${profile.instanceUrl} (${errorCodeOf(error)})`,
          errorCodeOf(error),
        );
      }

      if (failureCode !== undefined) {
        skip("credentials");
      } else {
        try {
          const user = await authenticate(profile.instanceUrl, profile.apiKey);
          checks.push({
            check: "credentials",
            status: "pass",
            detail: `authenticated as ${user.login}`,
          });
        } catch (error) {
          recordFailure("credentials", "could not verify credentials", errorCodeOf(error));
        }
      }

      if (failureCode !== undefined) {
        skip("permissions");
      } else {
        try {
          await apiGet(profile.instanceUrl, profile.apiKey, "/api/v3/projects?pageSize=1");
          checks.push({
            check: "permissions",
            status: "pass",
            detail: "can list projects",
          });
        } catch (error) {
          recordFailure("permissions", "cannot list projects", errorCodeOf(error));
        }
      }

      if (failureCode !== undefined) {
        skip("versions");
      } else {
        const apiMajor = info.apiVersion !== null ? majorOf(info.apiVersion) : undefined;
        const coreMajor = info.coreVersion !== null ? majorOf(info.coreVersion) : undefined;
        if (apiMajor !== undefined && apiMajor !== 3) {
          recordFailure(
            "versions",
            `API ${info.apiVersion} is not supported`,
            "UNSUPPORTED_VERSION",
          );
        } else if (coreMajor !== undefined && coreMajor < MINIMUM_CORE_MAJOR) {
          checks.push({
            check: "versions",
            status: "warn",
            detail: `core ${info.coreVersion} is below the minimum supported v13`,
          });
        } else {
          checks.push({
            check: "versions",
            status: "pass",
            detail: versionSummary(info),
          });
        }
      }

      if (options.json === true) {
        runtime.write(`${JSON.stringify({ ok: failureCode === undefined, checks })}\n`);
      } else {
        runtime.write(renderTable(
          ["CHECK", "STATUS", "DETAIL"],
          checks.map((check) => [check.check, check.status, check.detail]),
        ));
        for (const warning of checks.filter((check) => check.status === "warn")) {
          runtime.write(`warning: ${warning.check}: ${warning.detail}\n`);
        }
      }

      if (failureCode !== undefined) {
        throw new OpCliError(failureCode);
      }
    });
}
