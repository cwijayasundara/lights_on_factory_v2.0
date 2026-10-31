# Plan: rig-as-external-plugin

## Files
- scripts/install-cloud-profile.ts: replace `factoryCopy` with `resolveRigSource` (RIG_SOURCE checkout or cache fetch); drop `copy` from Pin and provenance.
- cloud/rig-profile/pin.json, .rig/CLOUD_PROFILE.json: remove `copy`.
- .gitignore: add the cache directory.
- tests/profile/cloud-profile.test.mts: the vendored-risk assertion (compared to the factory copy) and the doc test (factory copy name, "original Rig checkout is not modified") change as below; the wrapper type gains `rigSource` and `cacheRoot`; the file deletes `process.env.RIG_SOURCE` at load. Add source-resolution tests.
- docs/cloud-compatibility.md: Pin table row and "Rig remains a local harness" paragraph rewritten to the fetch-or-RIG_SOURCE source rule and "Rig changes land upstream in rig_v1, then the pin is bumped".
- docs/superpowers/specs/2026-10-31-lights-on-factory-design.md lines 100 and 102, docs/superpowers/plans/2026-10-31-lights-on-factory.md lines 25, 55, 71, 107 and 114: rewritten so Rig source work (e.g. the Task 4 context script and lifecycle refactor) is a PR to rig_v1 followed by a pin bump here, and the profile is generated from the pinned commit.
- factory-rig/: deleted only after it matches the fetched pinned commit (see Verification).

## Interfaces
- `type Pin = { repository: string; commit: string; version: string }`
- `export type InstallOptions = { target: string; factoryRoot: string; rigSource?: string | null; cacheRoot?: string }`: `rigSource` undefined reads `process.env.RIG_SOURCE`, null forces cache/fetch; `cacheRoot` defaults to `<factoryRoot>/.cache/rig`.
- `export function resolveRigSource(pin: Pin, opts: { rigSource: string | null; cacheRoot: string }): string`: returns the directory to vendor from; throws `Error` with the B1, B4, B5, B7, B8 messages.
- Fetch into `<cacheRoot>/.tmp-<random>`: `git init`, `git fetch --depth 1 <repository> <commit>`, `git checkout --detach FETCH_HEAD`, all with `GIT_TERMINAL_PROMPT=0` and a 120 s spawnSync timeout (timeout = B5 failure); then rename to `<cacheRoot>/<commit>`. The temp dir is removed on any failure. If the rename fails because the target already exists, re-check its HEAD and reuse it.

## Tests
All in tests/profile/cloud-profile.test.mts. Offline fixtures: a temp git repo with `uploadpack.allowAnySHA1InWant=true` holding plugin.json, LICENSE and a stub `scripts/sdlc.ts`, used as a `repository` or as `rigSource`, with a temp `cacheRoot`.
- B1 unit: bad commit and empty repository refused, each naming its field.
- B2 end-to-end: real install with `rigSource: null`; `.rig/bin/risk.ts` equals `<repo>/.cache/rig/<pin>/scripts/risk.ts`. Unit: fixture fetch creates `<cacheRoot>/<commit>` at HEAD = commit with no `.tmp-*` left.
- B3 unit: the fixture cache from B2, with the repository then rewritten to a nonexistent path, still resolves to the same directory.
- B4 unit: cache dir at another commit refused, naming the path and both commits; the dir still exists.
- B5 unit: nonexistent repository path, and fixture repo + absent 40-hex SHA, both fail naming the repository and commit, with no cache or `.tmp-*` dir left.
- B6 end-to-end: `rigSource` = a `git worktree` of the B2 cache at the pin; risk.ts matches and no new cache entry appears.
- B7/B8 unit: fixture at another HEAD refused naming both commits; an untracked file and a modified tracked file each refused naming the dir.
- B9 unit: fixture plugin.json version differing from the pin refused.
- B10 end-to-end: target CLOUD_PROFILE.json has no `copy` key; target `.rig/LICENSE` equals the source LICENSE; repo's CLOUD_PROFILE.json deep-equals pin.json.
- B11 unit: `.gitignore` lists the cache dir; the factory copy dir is absent; the installer and test sources do not contain its name (the name is built from pieces in the test).
- B12 unit: the existing doc assertions are kept (pin, path strategy, not observed, `enabledPlugins`, `CLAUDE_PLUGIN_ROOT`); added: `RIG_SOURCE` and the cache path; each of the three docs matches the one-sentence rule `/upstream[^.]*rig_v1[^.]*pin/i` and does not contain the factory copy name.
- B13 end-to-end: existing hook, skill, setup, missing-checker and secret tests kept as they are.

## Contracts
none

## Verification
- Before deleting the factory copy: `git diff --no-index --stat` between it and the fetched `.cache/rig/<pin>`, excluding node_modules and .git; stop and ask the person if anything differs.
- `node --disable-warning=ExperimentalWarning --test tests/profile/cloud-profile.test.mts`
- `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts check`

## Decisions
- `cacheRoot` was added so fixtures exercise fetch and reuse on every run, not only the first (review findings 1 and 2).
- A mismatched cache is refused, not deleted. A cache at the pinned commit is reused without a clean-tree check: it is installer-owned.

## Open questions
none
