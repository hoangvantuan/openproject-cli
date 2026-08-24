# An explicit --profile carries that entry's URL and key over the environment

`resolveProfile` decides which OpenProject instance a command hits, so its precedence rule is load-bearing. Before this decision the resolver conflated profile *selection* with profile *values*: `--profile X` chose only the label X, while `OPENPROJECT_URL` / `OPENPROJECT_API_KEY` still supplied the instance and key. A command could then write to a different instance than the one the user named while every output line claimed otherwise (#20).

## Considered options

**Chosen (A): an explicit `--profile X` flag is the top of the documented order.** The named entry's stored URL and key beat the environment for that command; the environment is consulted only for values the entry lacks (an entry without a stored key falls through to `OPENPROJECT_API_KEY`). This matches how the flag reads and removes the wrong-instance write hazard: what `auth status --profile X` shows agrees with what `auth list` lists under X.

The alternative (B) kept the environment above any selected profile and instead forced the output to stop claiming the overridden profile. It was rejected because it preserves the trap rather than removing it: a user who names a profile still silently hits another instance, just with an honest label.

`OP_CLI_PROFILE` deliberately stays in the environment tier and keeps today's behaviour (environment first, then the named entry): it is itself an environment variable, so the documented order "flags, then environment" applies unchanged to it.

## Consequences

- **The display name follows provenance, not selection.** A run renders as a named profile only when that profile's own URL *and* key were actually used. When the environment serves the run (no flag, or `OP_CLI_PROFILE`, with `OPENPROJECT_URL`/`OPENPROJECT_API_KEY` set), the run renders as the implicit `env` profile so `auth status` can never contradict `auth list`.
- The flag/env asymmetry is now deliberate: the flag tier beats the environment; `OP_CLI_PROFILE` does not.
- Mixed runs are labelled honestly even when half-served: if the environment supplies only the key for a profile whose URL was used, the run claims neither name cleanly and renders as `env`.
