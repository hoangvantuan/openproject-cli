import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readStoredMetadata } from "../context/metadata.js";
import { peekActiveProfile } from "../context/profile.js";
import type { RunEnvironment } from "../run.js";

async function cliVersion(): Promise<string> {
  try {
    const raw = await readFile(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Builds the --version output: the CLI version always, plus the stored
// instance versions when cached metadata is available. Deliberately runs
// without credentials and without any network access; it only reads files.
export async function buildVersionOutput(env: RunEnvironment): Promise<string> {
  const lines = [`op-cli ${await cliVersion()}`];
  try {
    const active = await peekActiveProfile(env);
    if (active !== undefined) {
      const stored = await readStoredMetadata(env, {
        name: active.name,
        instanceUrl: active.instanceUrl,
        apiKey: "",
        project: undefined,
      });
      const versions = [
        typeof stored?.instance.api_version === "string"
          ? `api ${stored.instance.api_version}`
          : undefined,
        typeof stored?.instance.core_version === "string"
          ? `core ${stored.instance.core_version}`
          : undefined,
      ].filter((part) => part !== undefined);
      if (versions.length > 0) {
        lines.push(`instance ${active.instanceUrl} (${versions.join(", ")})`);
      }
    }
  } catch {
    // Version output must survive a broken config or cache directory.
  }
  return lines.join("\n");
}
