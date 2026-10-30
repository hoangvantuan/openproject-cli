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
An instance's configurable vocabulary: types, statuses, priorities, custom fields, versions, categories, activities, sprints, backlog buckets, and members. What resolution reads. Stored on disk per profile as an implementation detail, refreshable and safe to delete, never something the user has to manage. A project's versions, categories, activities, sprints, and backlog buckets are each optional: one the account may not read is stored as **unavailable**, and only resolution that needs it fails.
_Avoid_: cache, schema, config

**Resolution**:
Translating a human-facing name (`"User Story"`, `"Sprint 12"`, `"Hung"`) into the id or HAL href the API requires, using cached instance metadata. The core value of this CLI; the reason a thin REST proxy would not be enough.
_Avoid_: lookup, mapping, translation

**Work package**:
OpenProject's unit of work, of some type (Task, Bug, User Story, or any instance-defined type). Abbreviated `wp` on the command line.
_Avoid_: task, issue, ticket, card

**Backlog inbox**:
The work packages of a project that sit in neither a sprint nor a backlog bucket. A placement state of the backlogs module, listed with `wp list --backlog-inbox`.
_Avoid_: inbox on its own, notification inbox (the unrelated read/unread feed behind `op-cli notification`)

**Watcher**:
A user subscribed to a work package's changes, managed with `wp watch` / `wp unwatch` and listed with `wp watchers`. Plain users: the watcher's id is the user id.
_Avoid_: follower, subscriber

**Attachment**:
A file stored on a work package, addressed by its own attachment id (not the work package id), as listed by `wp attachments` and fetched with `wp attachment-download`. There is deliberately no delete.
_Avoid_: upload, file (for the stored record)

**Escape hatch**:
Any route to an endpoint the CLI does not cover: a raw request command, a printed `curl` line, an exposed auth header. Deliberately absent. Bypassing resolution defeats the CLI's purpose, so the answer to an uncovered endpoint is to cover it with a command.
_Avoid_: passthrough, raw mode, proxy
