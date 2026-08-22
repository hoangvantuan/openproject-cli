# No escape hatch to the raw API

The whole reason this CLI exists is resolution: turning names into ids and HAL hrefs so nobody has to hardcode `customField8` or `/api/v3/types/7`. Any route that reaches the API without passing through resolution defeats that, so we deliberately ship none: no `op-cli api <VERB> <path>` passthrough, no `op-cli auth curl` printer, no command that prints the auth header, no raw `--filter 'field op value'` on list commands. An endpoint we do not cover is not reachable through this tool; the fix is to add a command for it.

## Considered options

An `api` passthrough was in the original plan, guarded by a stderr warning and a line in SKILL.md telling the agent to prefer real commands. We rejected it because it repeats the exact failure the CLI is meant to end: a caller reaching for `api POST /work_packages` is back to hardcoded ids, only now routed through our binary, and a prompt-level warning is not a constraint. A read-only `api GET` survived one round of discussion (harmless, useful for discovery) and was dropped too, because the same discovery need is served by `--help` plus `op-cli meta`, and a half-open door still needs documenting, testing, and defending.

## Consequences

- Coverage gaps become visible immediately instead of being papered over, which is the point: "not covered" and "not doable" are the same sentence, so we find out what is actually needed.
- Adding a domain must therefore be cheap. The command layer is built around a declarative helper so that a thin proxy domain (no resolution, just auth plus HAL flattening plus exit codes) costs under 30 lines and no design discussion.
- The accompanying skill must carry the boundary explicitly, because this is the one rule `--help` can never teach: when the CLI lacks a command, report back and stop. Do not fall back to `curl`, do not read `credentials.json`. Without that clause an agent simply routes around the decision, and the destructive-command refusals (ADR-0003 territory: `project delete` and `user delete` are refused outright) go with it.
