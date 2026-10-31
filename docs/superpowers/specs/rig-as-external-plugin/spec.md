# Spec: rig-as-external-plugin

## Behaviours

- B1: `cloud/rig-profile/pin.json` holds `repository`, `commit` and `version` only; the installer refuses a pin whose `commit` is not a 40-character hex SHA or whose `repository` is empty, naming the bad field.
- B2: With no `RIG_SOURCE`, the installer fetches the pinned commit from the pinned repository into `<factoryRoot>/.cache/rig/<commit>` and runs `vendor --standalone` from there; the target's `.rig/bin/risk.ts` equals that cache's `scripts/risk.ts`.
- B3: A second install reuses the existing cache directory whose checked-out commit equals the pin, without fetching again.
- B4: An existing cache directory whose checked-out commit is not the pinned commit is refused with a message naming the path and both commits; the installer does not delete it.
- B5: A fetch that fails (unreachable repository or unknown commit) fails visibly naming the repository and commit, and leaves no `.cache/rig/<commit>` directory behind.
- B6: With `RIG_SOURCE=<dir>` pointing at a git checkout whose HEAD equals the pinned commit and whose working tree is clean (no tracked changes, no untracked files), the installer vendors from that directory and does not create a cache entry.
- B7: `RIG_SOURCE` pointing at a checkout whose HEAD differs from the pin is refused, naming both commits.
- B8: `RIG_SOURCE` pointing at a checkout with tracked changes or untracked files is refused, naming the directory.
- B9: When the source's `.claude-plugin/plugin.json` version differs from the pin's `version`, the installer refuses (kept behaviour).
- B10: The target's `.rig/CLOUD_PROFILE.json` holds `repository`, `commit` and `version` with no `copy` field, and `.rig/LICENSE` is copied from the source (this repo's own `.rig/CLOUD_PROFILE.json` matches).
- B11: `.cache/` is gitignored, `factory-rig/` no longer exists, and neither the installer nor the tests reference `factory-rig`.
- B12: `docs/cloud-compatibility.md` records the pin, the `$CLAUDE_PROJECT_DIR/.rig/bin/sdlc.ts` path strategy, that a native cloud session was not observed, the fetch/`RIG_SOURCE` source rule, and that factory-driven Rig changes go upstream to `rig_v1` and arrive by bumping the pin; the lights-on design and plan docs say the same and no longer direct work into `factory-rig/`.
- B13: Kept: a fresh install resolves every hook and the four skills without `CLAUDE_PLUGIN_ROOT`, SessionStart runs twice, `.rig/.gate` is absent, the environment setup fails visibly on missing/old Node, a deleted checker fails visibly and a secret-pattern edit exits 2 with `sdlc check failed`.

- B14 (added 2026-10-31 after the person said the factory must not be a Rig target): the factory repository has no `.rig/`, `rig-*` skills, Rig agents, `.claude-plugin/` or Rig hooks/plugins in `.claude/settings.json`, and `installCloudProfile` refuses a target that is the factory root or inside it. B10's check of this repo's own `.rig/CLOUD_PROFILE.json` was dropped, because this repo no longer has one.

Note: this change began under Rig's own workflow (`.rig/changes/rig-as-external-plugin/`). After Rig was removed from this repository, it was finished without Rig, and this folder keeps its record.

## Blast radius

scripts/install-cloud-profile.ts
cloud/rig-profile/pin.json
.rig/CLOUD_PROFILE.json
.gitignore
tests/profile/
docs/cloud-compatibility.md
docs/superpowers/specs/2026-10-31-lights-on-factory-design.md
docs/superpowers/plans/2026-10-31-lights-on-factory.md
factory-rig/

## Out of scope

- Bumping the pin past `f33015b` (separate change).
- Any edit to the `rig_v1` repository or the local checkout at `learning_101/rig_v1`.
- Running a native cloud session; the "not observed" status stays.
- Installing Rig's npm devDependencies in the cache (vendoring needs none).
- The untracked root `package-lock.json`.

## Decisions

- Factory-driven Rig changes go upstream to `rig_v1`; this repo only bumps the pin (person, 2026-10-31).
- Source: fetch into gitignored `.cache/rig/<commit>`, with a `RIG_SOURCE` override refused unless clean and at the pinned commit (person).
- Pin stays at `f33015bf12e711be7441eca45fefb177fd5d81cc` / 0.7.0 (person).
- Tests run the real installer, so the first run needs network; refusal cases use temp git repos offline (person).
- A mismatched cache is refused, not silently deleted (my call: no destructive surprises).

## Open questions
none
