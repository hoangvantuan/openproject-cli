# 2026-11-16 Session Decisions

Recorded on 2026-11-16 against repository state `hoangvantuan/openproject-cli@bf2883c`.

## Triage and Backlog (#60, #61)

- On 2026-11-16, the maintainer confirmed keeping human-mode output of `wp create --no-watch` (#61) as the `FIELD` / `VALUE` table produced by `renderRecord` (with `watching: false` on success or `watching: null` on failed unwatch added to the flat record), rather than replacing the table with a prose sentence. The `"work package <id> was created, not watching"` string serves solely as the `done` prefix if `--fields` validation fails after the mutation. See [Issue #61](https://github.com/hoangvantuan/openproject-cli/issues/61).
- On 2026-11-16, #61 was labeled `enhancement` and `ready-for-agent` alongside #60 (`project version create`).
- On 2026-11-16, #60 and #61 passed 2-axis `/code-review`, addressed review feedback (`638712c` and `156e913`), passed full lint/test suites (812/812 and 811/811), and opened Ready-for-Review PRs [PR #68](https://github.com/hoangvantuan/openproject-cli/pull/68) and [PR #69](https://github.com/hoangvantuan/openproject-cli/pull/69) against `main`.

## `op-cli query` Design

- On 2026-11-16, the maintainer approved full lifecycle coverage (Option A) for saved queries: `list`, `get`, `run`, `star`, `unstar`, `create`, `update`, and `delete --yes`, plus adding a **Query** glossary entry to `CONTEXT.md`.
- On 2026-11-16, the `op-cli query` specification and vertical-slice task graph were published on GitHub: Spec [#62](https://github.com/hoangvantuan/openproject-cli/issues/62), with sub-issues [#63](https://github.com/hoangvantuan/openproject-cli/issues/63) (`list`/`get` + resolution + glossary, unblocked) blocking [#64](https://github.com/hoangvantuan/openproject-cli/issues/64) (`run`), [#65](https://github.com/hoangvantuan/openproject-cli/issues/65) (`star`/`unstar`/`delete`), and [#66](https://github.com/hoangvantuan/openproject-cli/issues/66) (`create`/`update`).
- On 2026-11-16, the maintainer approved `op-cli query run <id-or-name|default>` as a dedicated command (rather than adding `--query` to `wp list`) to avoid conflicts with `wp list`'s 23 standalone filter flags. In table mode, `query run` honors the query's stored columns when present (unless `--fields` overrides); `--json` keeps full flattened records per `docs/adr/0003-json-records-are-the-api-flattening.md`.
- On 2026-11-16, the maintainer approved query scoping rules: when a `project` is in context (`--project`/`--workspace` or profile default), `query list` and name resolution scope to that project (`project = <id>`); `--global` targets global queries (`project !*`); `--all-projects` queries across all visible projects; exact-name ambiguity within scope errors via `USAGE_ERROR` listing candidate IDs.
- As of `hoangvantuan/openproject-cli@bf2883c`, `query` remained deferred in `PLAN.md` with no command module registered in `src/run.ts`.
- On 2026-11-16, slices `#63`–`#66` were implemented and integrated on `feat/query-commands`, updated after 2-axis `/code-review` in commit `80ec596` (`43` test files, `875` tests passed locally; `CI/verify` green), and marked Ready for Review in [PR #67](https://github.com/hoangvantuan/openproject-cli/pull/67).

## Engineering Environment & Delivery

- On 2026-11-16, the maintainer approved storing tribal memory in `docs/wiki/`, creating `CODING_STANDARDS.md` at the repo root for code-review standards, using GitHub Issues in `hoangvantuan/openproject-cli` as the single issue tracker, and gating merges to `main` via Pull Requests reviewed by `/code-review` and approved by the maintainer.
- On 2026-11-16, `CODING_STANDARDS.md`, `docs/wiki/` pages (including `2026-11-16-retro.md`), and concise pointers in `AGENTS.md` were packaged on branch `docs/chief-of-staff-env` as a Ready-for-Review PR targeting `main`.

## Related Pages

- [2026-11-16 OpenProject v17.9.6 API Notes](2026-11-16-openproject-v17-api-notes.md)
- [2026-11-16 Subagent Execution Pitfalls](2026-11-16-subagent-pitfalls.md)
- [2026-11-16 Session Retro](2026-11-16-retro.md)
