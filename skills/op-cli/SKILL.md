---
name: op-cli
description: Drive OpenProject from an agent through the op-cli command-line client. Use when a task involves OpenProject, projects, work packages, time entries or time logging, instance metadata such as types and statuses, or any op-cli subcommand; resolves human names to ids and reports machine-readable error codes.
---

# op-cli

A resolving CLI for OpenProject: every flag accepts a human name or an id,
and the tool turns names into ids itself. Run any command below with
`--help` for its full reference; this file teaches only what it cannot.

## Boundary (read first)

- If the CLI lacks a command for what you need, stop and report that gap to
  the user. Do not fall back to `curl`, hand-built HTTP calls, or reads of
  `credentials.json`; there is no passthrough by design.
- Deletions need an explicit `--yes`: `wp delete <id> --yes`,
  `time delete <id> --yes`, `project delete <reference> --yes`. They are
  irreversible; never work around a refused deletion through another route.
  There is no `user delete`; report that gap instead of improvising.
- Three conventions are easy to guess wrong:
  - `--field "Estimate=5"` sets a custom field by human name;
    `--field "Estimate="` clears it.
  - `--all --json` streams NDJSON: one JSON record per line, not an array.
  - A truncated list warns on stderr ("Showing X of Y records. Pass --all")
    while data stays on stdout and the exit code stays 0.

## Session start

```sh
export OP_CLI_OUTPUT=json
op-cli auth status
```

Set JSON output once for the whole session instead of remembering a flag
per command; errors render as JSON objects carrying a stable `code`. If
auth status reports no profile or failed authentication, run
`op-cli auth login` (interactive prompts) before anything else.

## Intent to command

```sh
# find work packages; repeat a filter flag to OR values
op-cli wp list --open --type Task --assignee me --updated-after 7d
# how many match, without paginating; fetch every page with --all
op-cli wp count --priority High
# inspect one work package, optionally narrowing columns
op-cli wp get <id> --fields id,subject,status
# create one work package with values given by name
op-cli wp create Subject --type Bug --priority High
# set a custom field by name; an empty value after = clears it
op-cli wp update <id> --field Estimate=5
# change status, assignee, version, category, priority
op-cli wp update <id> --status Closed --assignee me
# build hierarchies: nest under a parent work package
op-cli wp create Sub-task --parent <id>
op-cli wp update <id> --parent <parent-id>
# give a work package a markdown body
op-cli wp create <subject> --description <markdown>
# delete needs explicit confirmation; bulk-create from a JSON array
op-cli wp delete <id> --yes
echo '[{"subject":"First"},{"subject":"Second"}]' | op-cli wp create --stdin
# discuss and audit a work package
op-cli wp comment <id> <text>
op-cli wp history <id>
# relations between work packages
op-cli wp relations <id>
op-cli wp relate <id> <to>
# which fields exist for a work package's project and type
op-cli wp schema <id>
# log and manage time; hours accept 1.5, 1h30m, PT1H30M
op-cli time log <id> --hours 1h30m --activity Development
op-cli time list --wp <id> --from today
op-cli time report --from 7d --user me
# projects: search, inspect, create with explicit identifier, copy
op-cli project list --search web
op-cli project create Web --identifier web
op-cli project copy <reference> Copy --identifier web-copy
# add or remove project members; without membership, assignment is refused
op-cli project member add <project> <user> <role>
op-cli project member remove <project> <user>
op-cli meta members
# what a work package may use in a project
op-cli project types <reference>
# instance vocabulary; members, versions, categories, activities too
op-cli meta fields
# something does not work: diagnose connectivity, credentials, versions
op-cli doctor
```

## Error contract

Read `[CODE]` on stderr (or `code` in JSON); do not match English prose.
Codes are a closed set with stable exit codes, 0 through 7.

| Code | Exit | Recovery action |
|---|---|---|
| USAGE_ERROR | 1 | fix flags or arguments; run the command again with `--help` |
| PROFILE_NOT_FOUND | 1 | run `op-cli auth login`; env vars alone also work |
| API_ERROR | 2 | OpenProject rejected or failed the request; retry later |
| INTERNAL_ERROR | 2 | retry once; if it persists, report with `op-cli doctor` output |
| AUTH_FAILED | 3 | credentials or permissions changed; run `op-cli auth login` |
| NOT_FOUND | 4 | check the id; run `op-cli meta refresh` if names changed recently |
| CONFLICT | 5 | someone edited the same work package; re-read, merge, retry |
| NETWORK_ERROR | 6 | check URL and network; after a write, state is unknown, verify first |
| UNSUPPORTED_VERSION | 7 | instance needs OpenProject v13+ (API v3); upgrade or report |
