# 2026-11-16 Subagent Execution Pitfalls

Recorded on 2026-11-16 during Wave-1 execution across `hoangvantuan/openproject-cli` worktrees (`feat/60-project-version-create`, `feat/61-wp-create-no-watch`, `feat/63-query-list-get`).

## Findings & Mitigations

1. **`gh issue view` returning empty stdout inside subagent shells**
   - *Observed*: Both `impl-60` and `impl-63` reported empty output from `gh issue view` in their worktrees, forcing reliance on prompt context alone.
   - *Mitigation*: Always inline the full issue specification and acceptance criteria inside delegated subagent prompts instead of relying solely on `gh issue view` pointers.

2. **`test/skill-consistency.test.ts` splits `sh` fenced lines on whitespace (`\s+`)**
   - *Observed*: During `#63` (`eefb0f9`), documenting `op-cli query get "Open bugs" --fields ...` in `skills/op-cli/SKILL.md` failed `test/skill-consistency.test.ts` because `checkCommand()` splits shell lines with `line.split(/\s+/)`, treating `"Open` and `bugs"` as two positional arguments.
   - *Mitigation*: Always use single-token argument examples without spaces (e.g., `Roadmap`, `Bug`, `Sprint-12`) inside ```` ```sh ```` blocks in `skills/op-cli/SKILL.md`.

3. **Paseo server restarts stop active subagents**
   - *Observed*: A Paseo server restart stopped running/idle subagent callbacks before parent delivery on 2026-11-16.
   - *Mitigation*: Pair parallel Paseo subagent waves with a bounded `paseo heartbeat create` (with `--max-runs` and `--expires-in`) so the coordinator wakes up to inspect `paseo ls --json` and git branches even if a restart drops `notifyOnFinish`.

## Related Pages

- [2026-11-16 Session Decisions](2026-11-16-session-decisions.md)
- [2026-11-16 OpenProject v17.9.6 API Notes](2026-11-16-openproject-v17-api-notes.md)
