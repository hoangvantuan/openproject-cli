# Notification routing context survives flattening; read state is explicit

Notifications help agents find work, not decide that work is complete. Listing and viewing are read-only, use fresh instance data, and ignore implicit project defaults. Only explicit notification IDs may be marked read or unread; authorization to do so comes from the user's request or delegated workflow, not from having summarized a notification.

## Output trade-off

Keep ADR-0003's flat records and `{id,name}` links, with a narrow notification-specific extension: `resourceType`, `resourceHref`, and `activityHref` preserve polymorphic routing information. `resourceType` uses the embedded API type when available, otherwise `WorkPackage` for a work-package href or the API collection segment for other resources; absent information is null. Notification-owned embedded `details` are flattened into `details` when no top-level details exist. Embedded work packages and their history are not merged or fetched. This deliberately supplements ADR-0003: dropping every embedded field and href would remove the information an agent needs to interpret a notification and choose its next command. `--fields` remains the caller's projection.

List stdout stays an array for one page and NDJSON for `--all`. A separate `type: "pagination"` JSON line on stderr for each fetched page exposes count, total when known, and continuation without introducing an envelope or mixing metadata into record streams. Consumers must distinguish these from stderr error records. All-page retrieval is not a snapshot: concurrent changes can cause duplicates or omissions.

## Mutation outcomes

Each distinct requested ID gets `changed`, `already-target`, `failed`, or `unknown`. `already-target` requires a verified boolean state from a fresh read and describes that observation, not a concurrency guarantee. Writes are never retried. Transport failures, write 5xx, and unexpected success responses are indeterminate, not proof that no change occurred. All outcomes remain on stdout even when the command exits nonzero; callers inspect individual results before deciding on recovery. There is no collection-wide fallback and no rollback of successful IDs.
