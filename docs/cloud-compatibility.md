# Native-cloud Rig compatibility

Date checked: 2026-10-31. Status: a native cloud session was observed (experiment 1, see "Native session evidence"). The vendored profile loads and its hooks enforce in an ordinary single-repository cloud session. Unattended operation is not yet proven: the session stopped at every permission prompt, and its results branch was never pushed.

## Pin

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/cwijayasundara/rig_v1 |
| Upstream commit | `f33015bf12e711be7441eca45fefb177fd5d81cc` |
| Plugin version | 0.7.0 |
| Source | the pinned commit, fetched into the gitignored `.cache/rig/<commit>`, or a clean `RIG_SOURCE` checkout at exactly that commit |
| Install | `scripts/install-cloud-profile.ts <target>` runs `vendor --standalone` from that source into a target repository |

Rig is a separate harness. The factory uses it as the behavioural harness for Claude Code sessions in target repositories. This repository is never a Rig target: it has no `.rig/`, `rig-*` skills or Rig hooks, and the installer refuses a target that is this repository or inside it. The factory keeps no copy of Rig's source. Factory-driven Rig changes go upstream to rig_v1 as their own changes, and the factory adopts them by bumping the pin.

Source rules. With `RIG_SOURCE` unset, the installer fetches the pinned commit (`git fetch --depth 1`, no credential prompt, 120 s timeout) into `.cache/rig/<commit>` and reuses that directory afterwards. A cache directory at any other commit is refused, not deleted. With `RIG_SOURCE` set, the checkout must be at the pinned commit with no uncommitted or untracked files. A failed fetch leaves no cache or temporary directory behind.

## What the current cloud docs load

Checked against [Configure cloud environments](https://code.claude.com/docs/en/cloud-environments) and [Skills in cloud sessions](https://code.claude.com/docs/en/skills). This matches the design's compatibility section.

Ordinary single-repository sessions, outside Claude Projects threads, load committed `.claude/skills/`, `.claude/agents/`, and `.claude/settings.json` hooks and permission rules. They do not load `~/.claude/` from the operator's machine. `enabledPlugins` and `extraKnownMarketplaces` in the repository settings do not install plugins. A Projects thread does not run repository settings hooks and does not load repository skills the same way. Do not use a Projects thread for this proof.

Anthropic-hosted VMs are Ubuntu 24.04 with Node 22 on `PATH` (`/opt/node22`). Rig's own hooks refuse to run under Node older than 22.18. `cloud/environment-setup.sh` is the toolchain check: it exits 0 when Node is new enough and exits 1 with `Node.js >= 22.18` on stderr otherwise. It is idempotent. The installer registers it as a SessionStart hook, so the **Default** environment needs no setup script. (An environment's setup script is text pasted into the environment dialog, not a path in the repository.)

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
- `.rig/bin/risk.ts` matches `scripts/risk.ts` at the pinned commit in `.cache/rig/<commit>`
- fetch, cache reuse, a stale cache, a failed fetch, and `RIG_SOURCE` at the wrong commit or dirty are covered with offline fixture repositories
- the installer refuses this repository as a target, and this repository carries no vendored Rig
- SessionStart can run twice
- deleting `.rig/bin/sdlc.ts` makes the hook command fail visibly
- a file containing an AWS example access key makes `hook post-edit` exit 2 with `sdlc check failed`
- `cloud/environment-setup.sh` fails visibly when Node is missing or reports `v20.11.0`

## Native session evidence

Experiment 1 (`docs/experiments/01-rig-enforces-in-cloud.md`), 2026-10-31. Session `session_012PjRkTZiSGP2nv4yUAp6SL` (https://claude.ai/code/session_012PjRkTZiSGP2nv4yUAp6SL). Ordinary single-repository session on the disposable private repo `cwijayasundara/rig-cloud-probe`, Default environment, no setup script. Started with `claude --cloud` from a terminal. The evidence below was reported by the session itself and pasted back by the operator.

| Check | Result | Evidence |
| --- | --- | --- |
| Runtime | pass | `2.1.316 (Claude Code)`, Node `v22.23.4` (≥ 22.18), `CLAUDE_CODE_REMOTE=true`; `.rig/CLOUD_PROFILE.json` shows `f33015bf…`, 0.7.0 |
| Skills and agents load | pass | 13 `rig-*` skills listed (app, arch, build, chart, init, learn, plan, pr, rule, start, test, testplan, wiki) plus agents `rig-architect`, `rig-evaluator`. The human-only skills (`approve`, `waive`, `autonomy`) were not listed, as intended |
| SessionStart hook | pass | `SessionStart hook additional context: sdlc harness is active in this repo (artifacts in .rig/).`; Rig also installed its git hooks: `core.hooksPath = .rig/githooks` (pre-commit, pre-push) |
| Post-edit enforcement | pass | `PostToolUse:Write hook blocking error from command: "node … .rig/bin/sdlc.ts hook post-edit": … sdlc check failed, fix before continuing: /home/user/repo/notes.txt:1: possible AWS access key` |
| Manual `hook session-start` | pass | emitted the SessionStart JSON, `exit=0` |
| Stop hook | not shown | no hook error was reported when the turn ended; no positive trace captured |

What this does and does not prove:

- **Enforcement is feedback after the edit, not prevention.** A PostToolUse hook runs after the write: `notes.txt` was created, then Claude was told to fix it. What actually stops bad work is the git pre-commit and pre-push hooks the profile installs in the VM, plus independent CI (plan Task 6). A session can't land a secret as long as CI checks it too.
- **Unattended runs stall at every permission prompt.** In the default permission mode, the session stopped for a person at each Write, Bash and git call. Rig's committed allow list covers only its own skills and checker. A factory session needs a target-repo permission policy (for example `permissions.defaultMode` plus allow rules for build, test and git commands) installed with the profile, or a task configuration that sets the mode. This needs a person's decision, because it widens what an unwatched agent can do.
- **Publishing is unproven.** The session never pushed `probe/results-1`. The cause wasn't captured: a permission stall, or no push access because the Claude GitHub App isn't installed on the repo. Plan Task 2 covers this.
- **Not exercised:** `/rig-start` and the human approval stop (P4), a positive Stop-hook trace, triggering without a terminal, and the laptop being offline.
