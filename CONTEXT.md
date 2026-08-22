# openproject-cli

A command-line client for the OpenProject REST/HAL API, published to npm and paired with a Claude skill. Its reason to exist is not API access (that is `curl`) but **resolution**: turning the names humans and agents use into the ids and HAL hrefs the API demands.

## Language

**Instance**:
A single OpenProject deployment, identified by its base URL. Its configuration (types, statuses, priorities, custom fields) is per-instance, not universal.
_Avoid_: server, host, tenant

**Profile**:
A named triple of instance URL, API key, and default project. The unit of context: every command runs under exactly one profile, and stored metadata is keyed by it. Environment variables alone form an implicit, unnamed profile.
_Avoid_: account, environment, config, context

**Metadata**:
An instance's configurable vocabulary: types, statuses, priorities, custom fields, versions, categories, activities, and members. What resolution reads. Stored on disk per profile as an implementation detail, refreshable and safe to delete, never something the user has to manage.
_Avoid_: cache, schema, config

**Resolution**:
Translating a human-facing name (`"User Story"`, `"Sprint 12"`, `"Hung"`) into the id or HAL href the API requires, using cached instance metadata. The core value of this CLI; the reason a thin REST proxy would not be enough.
_Avoid_: lookup, mapping, translation

**Work package**:
OpenProject's unit of work, of some type (Task, Bug, User Story, or any instance-defined type). Abbreviated `wp` on the command line.
_Avoid_: task, issue, ticket, card

**Escape hatch**:
Any route to an endpoint the CLI does not cover: a raw request command, a printed `curl` line, an exposed auth header. Deliberately absent. Bypassing resolution defeats the CLI's purpose, so the answer to an uncovered endpoint is to cover it with a command.
_Avoid_: passthrough, raw mode, proxy
