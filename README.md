# op-cli

> **Not affiliated with OpenProject GmbH.** op-cli is an independent,
> community-developed command-line tool. It is not affiliated with, endorsed
> by, or connected to OpenProject GmbH in any way, and it makes no use of
> OpenProject branding or logos. "OpenProject" is a trademark of OpenProject
> GmbH; this tool only speaks the REST API of the OpenProject application you
> already run. See the NOTICE file for the full statement.
>
> **Early release.** This is an early 0.x release of a young tool. The
> command surface may still change between releases; pin your version
> if that matters to you.

A resolving CLI for OpenProject: every flag accepts a human name or an id,
and the tool turns names into ids itself. Errors carry stable `[CODE]`
markers so both humans and agents can react to them programmatically.

## Requirements

- Node.js 20 or newer.
- An OpenProject instance running v13 or later (API v3).

## From install to first useful command

The npm package is [@tuanhv/op-cli](https://www.npmjs.com/package/@tuanhv/op-cli):

```sh
npm install -g @tuanhv/op-cli
op-cli auth login        # prompts for URL and API key; needs an interactive terminal
op-cli wp list --open    # list open work packages of your instance
```

Prefer environment variables over a stored profile? Export
`OPENPROJECT_URL` and `OPENPROJECT_API_KEY` instead of running
`op-cli auth login`; every command picks them up automatically.

Run any command with `--help` for its full reference. Useful starting
points beyond the quickstart:

```sh
op-cli wp create "Fix login bug" --type Bug --priority High
op-cli wp update 123 --start 2026-09-01 --due 2026-09-30 --estimate 4h --done 40 --story-points 5
op-cli wp list --search login          # server-side subject search
op-cli wp update 123 --sprint "Sprint 14"   # or --bucket <name>, never both
op-cli wp list --backlog-inbox          # in neither a sprint nor a backlog bucket
op-cli wp watchers <id>                # list watchers; also `wp watch` / `wp unwatch`, `wp list --watcher me`
op-cli time log 42 --hours 1h30m --activity Development
op-cli time report --from 2026-08-01 --to 2026-08-31   # closed period
op-cli project member add web alice Manager   # join members so assignment works
op-cli project list --search web
op-cli wp move 42 archive              # move a work package to another project
op-cli doctor            # diagnose connectivity, credentials, versions
op-cli update            # self-update; prints the right command for Volta/Homebrew
```

## Things worth knowing

- **Errors are a closed set.** Every failure prints a stable code on stderr,
  such as `[CONFLICT]` or `[PROFILE_NOT_FOUND]`, with exit codes 0 through 8.
  Run `op-cli doctor` when something does not work.
- **A project in context narrows listings.** `--project`, or a profile's
  default project, scopes `wp list`, `wp count`, `time list`, and
  `time report` to that project and its subprojects. Without one, those
  four commands report instance-wide.
- **Finding things needs no id.** `wp list --search <text>` matches
  subjects server-side, `--created-after` / `--updated-after` bound by
  date, `--due-before` / `--due-after` / `--overdue` bound by due date
  (`7d` counts back from today; only `YYYY-MM-DD` reaches the future), and
  `time list` / `time report` take `--from` and an inclusive `--to`. Every name flag also accepts the human name or the id.
- **Tables respect the terminal.** Read from a terminal, a table is
  bounded to its width and long cells are cut with an ellipsis; `--json`
  output is never truncated.
- **Deletion is guarded.** Deleting a project is irreversible: `wp delete`,
  `time delete`, and `project delete` all require an explicit `--yes`.
  `user delete` is not offered at all; there is no workaround by design.
- **JSON records follow the API, `--fields` narrows them.** `--json` emits
  the flattened OpenProject record, so an instance's own custom fields show
  up without a CLI release; pass `--fields id,subject,status` on any
  record-returning command to keep only what you read. With `--all` a
  listing streams NDJSON, one record per line, not an array.
- **Profiles beat the environment only when named.** An explicit
  `--profile <name>` uses that profile's own instance URL and API key, even
  when `OPENPROJECT_URL` / `OPENPROJECT_API_KEY` are exported; without the
  flag the environment wins over the active profile. A command served by the
  environment reports itself as the profile `env`.
- **Update notices are interactive-only.** Commands run from a terminal
  check npm for a newer release at most once a day and print one stderr
  line; scripted use (stderr not a TTY) never checks, `--version` stays
  offline, and `OP_CLI_NO_UPDATE_CHECK=1` disables the check entirely.
- **No escape hatch by design.** If a command is missing there is no raw
  HTTP passthrough; report the gap instead of working around the tool.

## Notification inbox for agents

```sh
op-cli notification list --json                         # unread, across the profile
op-cli notification list --status all --project web --json
op-cli notification list --reason mentioned,assigned --wp 42 --json
op-cli notification list --all --json                   # all pages, NDJSON
op-cli notification get 123 --json
op-cli notification read 123 124 --json                  # explicit IDs only
op-cli notification unread 123 --json
```

`notification list` defaults to 20 records, page 1, sorted by notification ID
descending. `--status unread|read|all` selects read states; `--all` selects all
pages from `--page`. `--limit` controls page size, including with `--all`.
`--project` accepts a name, identifier, or ID and applies only when explicitly
passed: stored project defaults and `OP_CLI_PROJECT` are ignored. `--wp` and
`--reason` accept repeated flags or comma-separated values (OR within each
filter, AND between filters). Notifications are not grouped by work package.

Reads never mark notifications or open a browser. No inbox state is stored
locally, and no work-package history is fetched automatically. `list` and
`get` accept `--fields`; JSON keeps API fields and flat resource links, plus
`resourceType`, `resourceHref`, and `activityHref` for follow-up commands.
Notification-owned embedded details are retained, not embedded work packages.
When no embedded resource type exists, `resourceType` is `WorkPackage` for
work-package links, otherwise the linked API collection name, or null.

For JSON lists, stdout is an array (one page) or NDJSON (`--all`). **Stderr
also carries JSON:** one `{ "type": "pagination", "offset": 1,
"pageSize": 20, "count": 20, "total": 35, "hasMore": true,
"nextOffset": 2 }` record per page. `total` may be null; `nextOffset` is null
at the end. Parse stderr line by line, distinguishing pagination from
`{"error": ...}` records; do not treat nonempty stderr alone as failure.
Later-page failures preserve earlier NDJSON output and exit nonzero.
Concurrent inbox changes can cause omissions or duplicates across pages.

Only mark read/unread when the user requests it or explicitly authorizes that
step in a workflow. Summarizing a notification does not mean its work is done.
Mutations accept one or more space-separated IDs and deduplicate them. Each
result reports `changed`, `already-target` (verified at pre-read), `failed`, or
`unknown`. A write timeout, network failure, 5xx, or unexpected success response
is **unknown**, not proof that nothing changed: fetch the current state before
considering another write. Writes are not retried. Other IDs continue; partial
failures retain the complete result array and exit with the first error's code.
Successful IDs are not rolled back. There is no mark-all or filter-based write.

This surface requires the instance's in-app notifications API and individual
`read_ian`/`unread_ian` actions. Unsupported endpoints fail explicitly; the CLI
never falls back to a collection-wide mutation. Compatibility should be
smoke-tested against your deployed version before operational use.

## Companion skill

`skills/op-cli/SKILL.md` packages this CLI's workflows as a coding-agent
skill. It ships in this repository, not in the npm package; to install
it, clone the repo and copy that directory into your agent's skills folder:

```sh
cp -R skills/op-cli ~/.claude/skills/op-cli
```

## The Python predecessor

op-cli is a TypeScript rewrite of an earlier Python-based OpenProject skill.
That archived implementation lives on the `feature/openproject-skill` branch
of [claude-plugin](https://github.com/hoangvantuan/claude-plugin/tree/feature/openproject-skill).
It is kept unmerged as historical documentation of API quirks and field
mappings; do not build on it.

## Development

```sh
npm run build   # compile src/ to dist/
npm test        # unit tests over fixtures from a real instance
npm run lint
scripts/smoke.sh              # REQUIRED gate before publishing
npm publish --access public   # scoped package; public is not the default
```

`scripts/smoke.sh` exercises a real create, update, time log, and delete
lifecycle against a scratch project on a live instance configured through
`OPENPROJECT_URL` and `OPENPROJECT_API_KEY`. To keep writes inside an existing
test project, set `OP_CLI_SMOKE_PROJECT=<numeric-id>`; the gate verifies that
project, creates disposable work packages/time entries only inside it, and
cleans up known created IDs even on failure. Existing-project mode skips
project creation, project description writes, and favourites. A timed-out
creation can leave an unknown ID: inspect the test project before retrying;
cleanup never guesses records by name. It fails loudly at the first
broken step. On the disposable work package it also sets, clears (`""`),
and reads back with `wp get --json` the accountable, dates, estimate and
remaining work, percent complete, story points, version and observed-in,
sprint and bucket (including the clear-then-set move), and edits a comment;
optional steps print a `skip:` line when the project or schema lacks the
field. There are no automated integration tests by design; this
script is the regression net for real write paths before every publish.

Releases after the first can ship from CI: once the package exists and its
npm Trusted Publishers entry points at `.github/workflows/release.yml`,
pushing a `v*` tag has GitHub Actions publish with a short-lived OIDC token
and provenance; no npm token is stored anywhere.

## License
MIT; see the LICENSE file. See the NOTICE file for the trademark
statement.
