# Coding Standards

Judgement calls for implementers and reviewers of `openproject-cli`. Rules already enforced by `tsc` (`tsconfig.json`) and `eslint` (`eslint.config.js`) are intentionally omitted.

## Ubiquitous language

Follow `CONTEXT.md` across commands, flags, prose, docs, and error messages:
- Canonical terms: `instance`, `profile`, `project`, `metadata`, `resolution`, `work package` (`wp`), `backlog inbox`, `watcher`, `attachment`, `query`, `escape hatch`.
- `workspace` is an accepted input alias for `project` (`--workspace`, `op-cli workspace`), never a second concept in output, docs, or error prose unless naming both flags (`--project` / `--workspace`), per `docs/adr/0005-workspace-is-an-accepted-synonym-of-project.md`.

## No escape hatch

Per `docs/adr/0001-no-escape-hatch.md`:
- Every CLI flag and argument translates human-facing names into API IDs or HAL hrefs via `resolution`.
- Never accept raw API filter JSON, raw HAL endpoint paths, or passthrough request commands.

## Flat records and `--fields`

Per `docs/adr/0003-json-records-are-the-api-flattening.md` and `docs/adr/0004-notification-output-and-explicit-state.md`:
- Record-returning commands emit `flattenHalRecord` output under `--json` and support `--fields` projection.
- Commands that mutate state before knowing the returned record shape (`create`, `log`, `comment`) must validate `--fields` via a `done` prefix (e.g., `"work package <id> was created"`) so a typo in `--fields` never invites a duplicate write.
- Commands whose fields are known before any request (`update`) validate `--fields` before sending traffic.
- Single-record human tables follow `FIELD` / `VALUE` format via `renderRecord` / `renderTable`.

## Write safety, retries, and destructive guards

Per `docs/adr/0002-lazy-metadata-per-profile.md`:
- Never retry writes on network timeouts, transport errors, or `5xx` responses. Map unfinished or indeterminate writes to `NETWORK_ERROR` (exit `6`) with a verification hint telling the caller how to check stored state before retrying.
- Only retry a write once when proof-carrying retry rules apply (resolution drift on `404`/`422` where metadata refresh changed the resolved ID, or `lockVersion` `409` conflict where re-read confirms modified fields were untouched).
- Destructive `delete` commands must require `--yes` and refuse missing `--yes` with `USAGE_ERROR` before any resolution or network traffic.

## Paging, output streams, and errors

- Paged list commands supporting `--all` must declare `--json` with `PAGED_JSON_HELP`, stream NDJSON (one JSON object per line) under `--all --json`, and warn on stderr (`Showing X of Y ... Pass --all`) when truncated on a single page while exiting `0`.
- All failures surface as `OpCliError` using codes from `ERROR_CATALOGUE` (`src/core/errors.ts`). Validate flag combinations and empty/malformed values locally before making network requests.

## Behavioral tests and skill parity

- Test external CLI behavior through the `run(argv, env, io)` seam (`src/run.ts`) with `undici` `MockAgent` (`disableNetConnect()`), asserting exact HTTP method/path/payload and stdout/stderr/exitCode. Avoid testing private internal helpers in isolation when `run()` covers the contract.
- Whenever commands, flags, or error codes change, update `skills/op-cli/SKILL.md` (and `README.md` where command summaries live) and verify `test/skill-consistency.test.ts` passes.
- Write ```` ```sh ```` examples in `skills/op-cli/SKILL.md` using space-separated flags (`--flag value`) and single-token placeholder values (such as `Roadmap`, `Bug`, or `Sprint-12`) so `test/skill-consistency.test.ts` tokenizes every argument on `\s+` cleanly.
