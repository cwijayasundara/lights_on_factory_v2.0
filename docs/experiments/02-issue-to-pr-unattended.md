# Experiment 2: does a request become a PR with only one human checkpoint?

Status: ready to run. Not yet observed.

## Question

With Rig enforcing (experiment 1) and the unattended permission policy installed (`cloud/rig-profile/permissions.json`), can a cloud session take a small request through Rig's start → plan → build → test → PR flow, with a person involved only at the plan approval?

## Setup

- Probe repo `cwijayasundara/rig-cloud-probe` at `main` has the profile plus the permission policy.
- **You:** install the Claude GitHub App on `rig-cloud-probe` (https://github.com/apps/claude → Configure → choose only that repo). Without it the session can't push a branch or open a PR.

## Run

In your own terminal:
```
cd ~/Documents/learning_102/rig-cloud-probe
git pull
claude --cloud "$(cat ~/Documents/learning_102/lights_on_factory_v2.0/docs/experiments/02-probe-prompt.txt)"
```
Open the printed link. When the session replies `APPROVAL NEEDED: /rig-approve <slug>`, read its `spec.md`/`plan.md` if you like, then type `/rig-approve <slug>` in the session and then `continue`. Don't help it otherwise. Count every time you had to click or type anything.

## Pass criteria

| Measure | Pass |
| --- | --- |
| Permission prompts | 0 (the policy should cover everything) |
| Questions from Rig skills | answered by the agent itself, or ≤ 1 |
| Human approvals | exactly 1 (`/rig-approve`) |
| Hook blocks | any are fine if the agent fixes them itself |
| Outcome | a PR open on `rig-cloud-probe` with the change, a test, and Rig's PR body |

## Results

| Measure | Observed |
| --- | --- |
| Permission prompts | |
| Questions | |
| Approvals | |
| Hook blocks | |
| PR URL | |

Session URL:
Date:

## Decide

- **PR opened with one approval:** the per-change loop works. Experiment 3 runs three requests in parallel.
- **Stalls on permission prompts:** widen `permissions.json` only for the exact commands seen, with your agreement.
- **Stalls on Rig questions or gates beyond the approval:** that list is the upstream rig_v1 work for unattended mode (plan Task 4).
- **No PR:** check the GitHub App install. Note whether the push or the PR creation failed.
