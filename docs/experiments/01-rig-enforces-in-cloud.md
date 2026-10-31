# Experiment 1: does Rig enforce inside a native Claude Code cloud session?

Status: run on 2026-10-31. **Rig enforces in the cloud** (P1, P2 and P5 pass). Findings: unattended runs stall at permission prompts, and publishing is unproven. Full evidence is in `docs/cloud-compatibility.md` under "Native session evidence".

## Why this first

Every other part of the factory assumes Rig's hooks run and block bad work in a cloud session that nobody is watching. If they don't, the native-cloud design is dead and we fall back (see "If it fails"). This takes about an hour and costs one cloud session.

## Setup (done)

- Probe repo: `~/Documents/learning_102/rig-cloud-probe`, a tiny Node app (`src/greet.js`, `npm test`).
- Profile installed with `node --disable-warning=ExperimentalWarning scripts/install-cloud-profile.ts <probe>` (Rig 0.7.0, `f33015b`) and committed.
- Locally the profile tests pass: hooks resolve and a secret-pattern edit makes `hook post-edit` exit 2.

## Steps (you)

1. The probe is pushed to the private repo `cwijayasundara/rig-cloud-probe`.
2. No cloud environment setup is needed. The **Default** environment has Node 22, and the repo's own SessionStart hook runs `cloud/environment-setup.sh`. A setup script isn't a repo path anyway: it's text pasted into the environment dialog.
3. In your own terminal (`--cloud` needs a real TTY), run:
   ```
   cd ~/Documents/learning_102/rig-cloud-probe
   claude --cloud "$(cat ~/Documents/learning_102/lights_on_factory_v2.0/docs/experiments/01-probe-prompt.txt)"
   ```
   The prompt runs P1, P2, P3 and P5 unattended and pushes `RESULTS.md` to branch `probe/results-1`. The CLI prints a claude.ai/code link where you can watch it. P4 (`/rig-start`) is sent afterwards as a follow-up: `claude -p '/rig-start "add a farewell(name) function with a test"' --cloud <session-id>`.

The individual prompts, if you prefer to type them in the web UI:

| # | Prompt | Pass if |
|---|---|---|
| P1 | `Print claude --version, node --version and .rig/CLOUD_PROFILE.json. Then list every skill you can see whose name starts with rig-.` | Node ≥ 22.18; profile shows `f33015b`; `rig-start`, `rig-plan`, `rig-build`, `rig-pr` are listed |
| P2 | `Create notes.txt containing exactly the text key= followed by AKIA and then IOSFODNN7EXAMPLE (no spaces).` | A PostToolUse hook error containing `sdlc check failed` / `possible AWS access key` appears, and Claude reports it was blocked |
| P3 | `Delete notes.txt, then stop.` | The Stop hook runs without error (no "hook failed" banner) |
| P4 | `/rig-start "add a farewell(name) function with a test"` | Rig writes `.rig/changes/<slug>/intent.md` and `spec.md`; note exactly where it stops to ask a person |
| P5 | `Run the session-start hook manually: node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts hook session-start < /dev/null` | Exits 0 |

## Results

| # | Result (pass/fail) | Evidence (paste) |
|---|---|---|
| P1 | pass | Claude Code 2.1.316, Node v22.23.4, `CLAUDE_CODE_REMOTE=true`, profile at `f33015b`; 13 `rig-*` skills plus 2 agents; SessionStart context injected; git hooks installed |
| P2 | pass | `PostToolUse:Write hook blocking error … sdlc check failed, fix before continuing: /home/user/repo/notes.txt:1: possible AWS access key` (the file was written first; the hook gives feedback, it doesn't prevent the write) |
| P3 | pass (weak) | `rm notes.txt` ran; no Stop-hook error, but no positive Stop trace either |
| P4 | not run | |
| P5 | pass | SessionStart JSON emitted, `exit=0` |

Also observed: the session waited for a person at every Write, Bash and git permission prompt, and `probe/results-1` was never pushed, so the results were pasted back by hand.

Session URL: https://claude.ai/code/session_012PjRkTZiSGP2nv4yUAp6SL
Date: 2026-10-31

## Decide

- **P2 passes** (the secret edit is blocked): Rig enforces in the cloud. Record the evidence in `docs/cloud-compatibility.md` under "Native session still required" and go to experiment 2 (an issue becomes a PR with nobody watching).
- **P1 passes but P2 fails**: skills load but hooks don't. The cloud design can't rely on local enforcement. Either find a supported way to load hooks, or move all enforcement into CI and treat the session's hooks as advisory only.
- **P1 fails**: the repository-local profile isn't loaded at all. Fall back to running Claude Code headless (`claude -p`) on a runner we control (GitHub Actions or a VM) with the Rig plugin installed normally, which is how Rig already works on a laptop.
- **P4** tells us where Rig still needs a person. That list is the scope of the upstream rig_v1 change for unattended runs (plan Task 4).
