# Metadata is a per-profile lazy cache, and retries must prove they are safe

Resolution reads an instance's metadata (types, statuses, priorities, custom fields, versions, categories, activities, members). We store it as a true cache: fetched lazily on first need, refreshable, safe to delete at any time, never something the user initialises or manages. It is keyed by profile (`~/.cache/op-cli/<profile>/`), or by `env-<sha1(url)>` when the CLI is driven by environment variables alone, and `OP_CLI_CACHE_DIR` can relocate it.

## Considered options

The alternative was an explicit snapshot the user owns and refreshes (`cache init` as a required setup step, never auto-fetching). It makes every command fast and deterministic, but it adds a setup step to every piece of documentation and every agent session, and it makes "safe to delete" false. Keying by `sha1(url)` instead of by profile was also rejected: metadata content depends on the token's permissions, so two profiles against one URL (a personal token and an admin token) would poison each other's `members`, `custom_fields`, and `instance.user.admin`. For that reason the authenticated user's identity is not stored in shared instance metadata at all.

## Consequences

- A stale-but-present entry is a worse failure mode than a miss, so a TTL alone is not enough: a hit can be silently wrong after an admin renames a type. The recovery is a proof-carrying retry, applied in exactly two places and nowhere else.
- **Resolution retry**: after a write fails, retry once only if all three hold: the status is 404 or 422; OpenProject's body points at the very attribute we built from a resolved value; and refreshing the metadata actually changed that id. If a refresh changes nothing, the retry would fail identically, so we skip it and keep the error message honest. Timeouts and 5xx on writes are never retried: exit 6 says the state is unknown, which is better than silently creating duplicates.
- **Conflict retry**: `lockVersion` conflicts (409) are retried once only after re-reading and comparing against the original read. If nobody touched a field we are changing, the conflict was a race and the retry is safe. If they did, we stop with exit 5 and report the conflicting fields rather than overwriting a colleague's edit, which is what a blind retry would do.
