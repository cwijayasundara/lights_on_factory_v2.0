# Native-cloud Rig compatibility

Date checked: 2026-10-31. Status: scripted profile only. A native cloud session was not observed, so this note does not claim the profile is portable. Architectural rollout stays stopped until a disposable ordinary single-repository cloud session records the live evidence below.

## Pin

| Field | Value |
| --- | --- |
| Repository | https://github.com/cwijayasundara/rig_v1 |
| Commit | `f33015bf12e711be7441eca45fefb177fd5d81cc` |
| Plugin version | 0.7.0 |
| Install | `scripts/install-cloud-profile.ts` runs `git archive` of that commit, then Rig `vendor --standalone` |

The local checkout at `learning_101/rig_v1` was dirty and not at this commit. The installer never reads that worktree. It extracts the pinned commit.

## What the current cloud docs load

Checked against [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments) and [Skills in cloud sessions](https://code.claude.com/docs/en/skills). This matches the design's compatibility section.

Ordinary single-repository sessions, outside Claude Projects threads, load committed `.claude/skills/`, `.claude/agents/`, and `.claude/settings.json` hooks and permission rules. They do not load `~/.claude/` from the operator's machine. `enabledPlugins` and `extraKnownMarketplaces` in the repository settings do not install plugins. A Projects thread does not run repository settings hooks and does not load repository skills the same way. Do not use a Projects thread for this proof.

Anthropic-hosted VMs are Ubuntu 24.04 with Node 22 on `PATH` (`/opt/node22`). Rig's own hooks refuse to run under Node older than 22.18. `cloud/environment-setup.sh` is the toolchain check: it exits 0 when Node is new enough and exits 1 with `Node.js >= 22.18` on stderr otherwise. It is idempotent. The installer registers it as a SessionStart hook. The cloud environment dialog still has to point its setup script at this file; committing the file does not select it.

## Path strategy

Plugin hooks call `${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts`. A cloud session that does not install the plugin does not set `CLAUDE_PLUGIN_ROOT`. `vendor --standalone` rewrites those commands to `$CLAUDE_PROJECT_DIR/.rig/bin/sdlc.ts` and skill text to `.rig/bin/sdlc.ts`. Templates move to `.rig/templates/`. That is the path the profile uses. Do not point hooks back at `CLAUDE_PLUGIN_ROOT`.

`vendor --standalone` still writes `enabledPlugins` `rig@rig-local` and a `.claude-plugin/marketplace.json` for the dashboard mod. Cloud sessions will not install that plugin. The checker does not need it. `superpowers@claude-plugins-official` is not turned on by `vendor --standalone` (only by `init --full`). Chart skips Superpowers calls when that plugin is missing. Leaving the dashboard `enabledPlugins` entry in settings is harmless and is not an enforcement dependency.

## Dependencies that do not travel

| Dependency | Where Rig uses it | Cloud consequence |
| --- | --- | --- |
| Plugin install and `CLAUDE_PLUGIN_ROOT` | `hooks/hooks.json` and every skill's `S` command | Removed from the vendored profile by the rewrite above |
| `~/.claude` and `os.homedir()` | `scripts/learntranscripts.ts`, `scripts/superpowers.ts`, `scripts/runs.ts` `portable` | Home transcripts and user plugin state are absent. The post-edit checker does not read them |
| Managed settings on the machine | `/Library/Application Support/ClaudeCode` on macOS, `/etc/claude-code` on Linux | Not part of this profile. Server-managed settings, if an org has them, are separate |
| `AskUserQuestion` | chart, start, init, arch, app, rule, upgrade, approve, waive, autonomy | Those skills still stop for a person. `build`, `plan`, `pr`, and `test` do not ask. This profile does not remove the asking skills |
| Superpowers skills | chart and start | Not installed by a repository `enabledPlugins` entry. Chart continues without them |

Human-only skills (`approve`, `waive`, `autonomy`) are vendored with the standalone copy. They are not a cloud auto-approval path.

## Scripted evidence

`node --disable-warning=ExperimentalWarning --test tests/profile/cloud-profile.test.mts` checks:

- hook commands in a fresh install resolve to files under `$CLAUDE_PROJECT_DIR/.rig/bin/sdlc.ts` and do not mention `CLAUDE_PLUGIN_ROOT`
- `rig-chart`, `rig-plan`, `rig-build`, and `rig-pr` are present and call `.rig/bin/sdlc.ts`
- `.rig/bin/risk.ts` matches the pinned blob, not a dirty worktree
- SessionStart can run twice
- deleting `.rig/bin/sdlc.ts` makes the hook command fail visibly
- a file containing an AWS example access key makes `hook post-edit` exit 2 with `sdlc check failed`
- `cloud/environment-setup.sh` fails visibly when Node is missing or reports `v20.11.0`

## Native session still required

No Claude CLI revision, cloud session URL, loaded-skill list, or live hook trace was captured. Record these in a separately authorized disposable ordinary cloud session, not a Projects thread:

- `claude --version` and `.rig/CLOUD_PROFILE.json`
- SessionStart, post-edit, and Stop hook output
- one deliberate secret-pattern edit and the failed checker result
- which of `enabledPlugins` failed to load

Until that note exists, do not start Tasks 2–8 as if enforcement had been observed in the cloud.
