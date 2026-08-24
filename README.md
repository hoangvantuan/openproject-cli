# op-cli

> **Not affiliated with OpenProject GmbH.** op-cli is an independent,
> community-developed command-line tool. It is not affiliated with, endorsed
> by, or connected to OpenProject GmbH in any way, and it makes no use of
> OpenProject branding or logos. "OpenProject" is a trademark of OpenProject
> GmbH; this tool only speaks the REST API of the OpenProject application you
> already run. See the NOTICE file for the full statement.
>
> **Early release.** This is version 0.1.0 of a young tool. The command
> surface may still change between releases; pin your version if that
> matters to you.

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
op-cli time log 42 --hours 1h30m --activity Development
op-cli project member add web alice Manager   # join members so assignment works
op-cli project list --search web
op-cli doctor            # diagnose connectivity, credentials, versions
```

## Things worth knowing

- **Errors are a closed set.** Every failure prints a stable code on stderr,
  such as `[CONFLICT]` or `[PROFILE_NOT_FOUND]`, with exit codes 0 through 7.
  Run `op-cli doctor` when something does not work.
- **A project in context narrows listings.** `--project`, or a profile's
  default project, scopes `wp list`, `wp count`, `time list`, and
  `time report` to that project and its subprojects. Without one, those
  four commands report instance-wide.
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
- **`project copy` copies properties only** (description, visibility, and
  parent). It does not copy work packages, members, or wiki pages.
- **No escape hatch by design.** If a command is missing there is no raw
  HTTP passthrough; report the gap instead of working around the tool.

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
`OPENPROJECT_URL` and `OPENPROJECT_API_KEY`. It fails loudly at the first
broken step. There are no automated integration tests by design; this
script is the regression net for real write paths before every publish.

Releases after the first can ship from CI: once the package exists and its
npm Trusted Publishers entry points at `.github/workflows/release.yml`,
pushing a `v*` tag has GitHub Actions publish with a short-lived OIDC token
and provenance; no npm token is stored anywhere.

## License

MIT. See the NOTICE file for the trademark statement.
