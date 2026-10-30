# "Workspace" is an accepted synonym of "project"; collection links are followed

OpenProject 17 renamed projects to workspaces in API v3: project resources link their collections under `/api/v3/workspaces/{id}/...` (versions, categories, types, work packages, the create form), while `/api/v3/projects/{id}/...` still answers. Callers who learned the new word will type `--workspace`.

## Decision

**Both words are accepted; "project" stays canonical.** CONTEXT.md, command output, JSON keys, and error messages keep saying project (records mirror the API, ADR-0003, and the profile's stored default-project key is unchanged). "Workspace" is input vocabulary only:

- `--workspace <name-or-id>` is accepted on every command that accepts `--project`, with identical resolution. It is folded into `--project` before the action runs, so no command reads two options. Giving both with different values is a `USAGE_ERROR`; the same value on both is fine.
- `op-cli workspace <subcommand>` is registered from the same code as `op-cli project`, so the two groups cannot drift.
- Hints that name the flag mention `--workspace` as well.

**Links over paths.** The project resource's `_links` (`versions`, `categories`, `types`, `workPackages`, `createWorkPackage`, `memberships`) are stored with the project's vocabulary and followed instead of building `/api/v3/projects/{id}/...`; a missing link falls back to the projects path. Reading them costs one project GET when a vocabulary is fetched, never a request per command; a stored vocabulary from before this decision has no links and keeps working. Sprints and backlog buckets carry no link on the project, so their projects path is kept and a 404 is retried once under `/api/v3/workspaces/{id}/...` before the source is marked unavailable.

## Considered options

Renaming to `--workspace` and keeping `--project` as a deprecated alias was rejected: nothing is breaking today, and "project" is what every existing script, skill, and ADR says. Accepting only `--project` was rejected because the API's own vocabulary is moving. Resource references in write payloads (`_links.project`) still use the projects href; the API accepts it and this decision covers collections only.
