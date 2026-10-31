verdict: changes-needed

## Findings
1. [high] plan.md:22 B3 test cannot work: a temp factoryRoot has no cache (cache is under factoryRoot), so it would fetch; directory mtime is weak proof. Fix: seed the temp factoryRoot's cache from B2; keep unreachable-URL success as the proof; drop mtime.
2. [high] plan.md:21 B2 uses the repo's persistent cache, so fetch/init/checkout/rename/cleanup is only exercised on the first run ever. Fix: offline unit test with a local temp git repo as `repository` (uploadpack.allowAnySHA1InWant=true); assert cache appears with HEAD = commit and no temp dir left.
3. [high] plan.md:8 / spec.md:16 lights-on plan Task 4 (lines 107, 114) and design (lines 100, 102) direct Rig code into factory-rig; plan does not name those rewrites and B12 only asserts absence. Fix: name the rewrites (Rig work lands in rig_v1, then pin bump) and positively assert the rule in both docs.
4. [medium] plan.md:13 `rigSource` defaulting to env with undefined = default makes tests depend on a developer's RIG_SOURCE. Fix: `rigSource?: string | null` (null = fetch/cache) or tests delete the env var; update test wrapper type.
5. [medium] plan.md:15 fetch lacks GIT_TERMINAL_PROMPT=0 and a timeout; a private/unreachable repo can hang on a credential prompt. Fix: set it, add spawnSync timeout, timeout counts as B5 failure.
6. [medium] plan.md:24 B5 unknown-commit case untested. Fix: local temp repo + absent 40-hex SHA.
7. [medium] plan.md:25 B8 tracked-change case untested. Fix: add it.
8. [medium] plan.md:25,40 B6 only checks resolveRigSource's return, not vendoring. Fix: end-to-end with RIG_SOURCE at a clean checkout at the pin; risk.ts matches; no new cache entry.
9. [medium] plan.md:29 new doc test drops existing enabledPlugins / CLAUDE_PLUGIN_ROOT assertions; `/rig_v1/` already matches the URL. Fix: keep both; match the rule as one sentence.
10. [medium] plan.md:9 factory-rig/ is untracked; deletion is irreversible and unchecked against f33015b. Fix: diff against the fetched cache (excluding node_modules) first; stop on difference.

## Deferred
- B11 allow-list vs the B12 regex second occurrence: build the string from pieces.
- B10: assert LICENSE equals the source's.
- Cache reused without clean-tree check; concurrent rename ENOTEMPTY: on rename failure re-check HEAD and reuse.
- Local learning_101/rig_v1 is at 10e4a5c, so B7 would refuse it (expected).
