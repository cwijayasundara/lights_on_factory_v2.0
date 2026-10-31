# Experiment 1: does Rig enforce inside a native Claude Code cloud session?

Status: ready to run. Not yet observed.

## Why this first

Every other part of the factory assumes Rig's hooks run and block bad work in a cloud session that nobody is watching. If they don't, the native-cloud design is dead and we fall back (see "If it fails"). This takes about an hour and costs one cloud session.

## Setup (done)

- Probe repo: `~/Documents/learning_102/rig-cloud-probe`, a tiny Node app (`src/greet.js`, `npm test`).
- Profile installed with `node --disable-warning=ExperimentalWarning scripts/install-cloud-profile.ts <probe>` (Rig 0.7.0, `f33015b`) and committed.
- Locally the profile tests pass: hooks resolve and a secret-pattern edit makes `hook post-edit` exit 2.

## Steps (you)

1. Push the probe to a **private** GitHub repo:
   `gh repo create cwijayasundara/rig-cloud-probe --private --source ~/Documents/learning_102/rig-cloud-probe --push`
2. At claude.ai/code, add the repo and create a cloud environment for it. Set the setup script to `bash cloud/environment-setup.sh`. Start an **ordinary session on that repo**, not a Projects thread.
3. Send these prompts one at a time and copy each full reply (and any hook messages) into the table below.

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
| P1 | | |
| P2 | | |
| P3 | | |
| P4 | | |
| P5 | | |

Session URL: 
Date:

## Decide

- **P2 passes** (the secret edit is blocked): Rig enforces in the cloud. Record the evidence in `docs/cloud-compatibility.md` under "Native session still required" and go to experiment 2 (an issue becomes a PR with nobody watching).
- **P1 passes but P2 fails**: skills load but hooks don't. The cloud design can't rely on local enforcement. Either find a supported way to load hooks, or move all enforcement into CI and treat the session's hooks as advisory only.
- **P1 fails**: the repository-local profile isn't loaded at all. Fall back to running Claude Code headless (`claude -p`) on a runner we control (GitHub Actions or a VM) with the Rig plugin installed normally, which is how Rig already works on a laptop.
- **P4** tells us where Rig still needs a person. That list is the scope of the upstream rig_v1 change for unattended runs (plan Task 4).
