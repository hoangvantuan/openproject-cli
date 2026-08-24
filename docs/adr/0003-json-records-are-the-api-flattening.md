# The JSON record is the API's flattening, not a curated projection

Every record-returning command emits the same shape under `--json`: the HAL resource flattened in place, scalars untouched, each `_links` attribute reduced to `{ id, name }`. The alternative is a projection the CLI owns: a documented, per-resource list of fields, everything else dropped.

We keep the flattening. What the CLI projects is chosen per invocation with `--fields`, which every record-returning command accepts.

## Considered options

A curated projection reads better out of the box and is far cheaper in tokens for an agent. It was rejected because the fields worth keeping are exactly the ones we cannot enumerate: custom fields are per instance and per type, and surfacing an instance's own vocabulary is why this CLI exists (see `CONTEXT.md`, _Metadata_). A projection would have to be maintained against every instance it ever meets, and a field an admin added this morning would be invisible until the CLI shipped again. The flattening has the opposite failure mode, verbosity, which the caller can fix per command.

Left as-is, though, the flattening carried entries that were not data at all. OpenProject puts two kinds of thing under `_links`: attributes that point at a resource (`status`, `assignee`, `version`) and operations the caller may perform (`update`, `delete`, `pdf`, `configureForm`, `github_pull_requests`). An operation flattens to `{"id":null,"name":null}` when its href names no numeric resource, and to the record's **own** id when it does, so `delete` arrived spelled exactly like a resource attribute pointing at the work package itself.

## Consequences

- The flat record drops a `_links` entry that declares a `method` (an operation) and one that names nothing while pointing at a real href (a sub-collection endpoint such as `attachments`). Everything else stays, including an unset attribute whose href is `null`: "no category" is a fact, and `{"id":null,"name":null}` says it.
- Link presence can no longer be read as a permission signal. It never was one here in any documented sense; `op-cli wp schema <id>` reports what is writable.
- `--fields` is the projection, so it must exist wherever a record is
  returned. On a command that writes before it can know its record
  (`wp create`, `time log`) a bad `--fields` name after the write still
  says what landed, because a bare `USAGE_ERROR` invites the repeat that
  would write twice; `wp update`, whose columns are known before any
  traffic, refuses before touching anything for the same reason (see
  ADR-0002 on never inviting duplicate writes).
- Field names follow the API's own naming, so anything documented by OpenProject reaches the caller under the name OpenProject uses.
