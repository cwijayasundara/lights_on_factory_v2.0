# Lights On Factory — native Claude Code cloud design

Date: 2026-10-31. Status: draft for review; no product implementation or deployment.

## User expectation

PRD -> agent-generated architecture, all intents, specs, plans and tests -> human planning approval -> unattended code generation, verification, automated review and PR creation -> human review and merge of each implementation PR.

There are two planned human checkpoints: one complete planning-package approval, then review/merge of each implementation PR. Scope changes, missing business decisions, permissions that still require approval, exhausted limits and unresolvable failures are exceptional stops. The factory does not promise to eliminate those exceptions.

The coding agent is **Claude Code running on Anthropic's cloud**, as described in the user's reference. GitHub holds source, review/merge evidence, workflow state and CI. No separately hosted server, AWS/Azure stack, Pi replacement, or gh-aw worker runtime is required for v1.

This revision supersedes both earlier hosting drafts. The user selected GitHub-only first and then clarified that Claude's native hosted cloud is the intended coding runtime. Here, GitHub-only refers to the factory's own orchestration/storage; Anthropic supplies coding compute.

## Layers and retained assets

| Layer | Choice | Responsibility |
| --- | --- | --- |
| Model and coding runtime | Native Claude Code cloud session | Reasoning, editing, commands, agent context |
| Engineering workflow | Rig, adapted for cloud loading and batch approval | Intent/spec/plan discipline, local feedback, verification helpers |
| Execution host | Anthropic-managed cloud environment | VM, repository clone, startup toolchain and network policy |
| Automation trigger | Claude cloud scheduled tasks/routines | Start cloud sessions through documented API/GitHub triggers |
| Deterministic coordination | Small GitHub Actions controller | Human approval validation, ready-intent selection, retries, evidence and PR publication |
| Release authority | Human through GitHub | Review and merge implementation PRs |

Rig adds SDLC behavior to Claude Code; it is not an alternative model/agent runtime. Pi is a different coding-agent runtime. gh-aw is an Actions-based automation substrate that can launch Claude Code, but that agent would execute on the Actions runner rather than through the user's requested native cloud-session service. It replaces some orchestration responsibilities, not Rig's engineering policy automatically. See the [research note](../../research/2026-10-31-harness-options.md).

Keep Rig as the baseline. First prove its cloud portability; then remove duplicated interactive gates and unnecessary skills in the cloud execution profile. No claim that a new harness is more capable is justified without matched evaluations.

## Starting scope and defaults

- Empty local workspace; not yet a Git repository. All implementation paths in the plan are proposed.
- One operator, one onboarded GitHub target repository, one active PRD and one active implementation intent for the initial pilot.
- Markdown PRD plus repository-local attachments at an exact pushed source SHA. PDF/Word conversion and multi-repository Projects are deferred.
- Native ordinary single-repository cloud sessions, outside Claude Projects threads, are the first compatibility target.
- Node.js 24 LTS and erasable TypeScript for small factory helpers; npm, Zod, Octokit and built-in Node tests. Pin an actually supported Rig commit/CLI version during the compatibility proof.
- Maximum three open implementation PRs; two repair passes after the initial candidate; two transient trigger retries only when nonlaunch is confirmed.
- Controller reconciliation configured every five minutes, without promising five-minute delivery. Scheduled events can be delayed/dropped.
- Evidence artifact retention: 90 days where supported. Approval/authorization/result manifests persist in Git.
- Normal tests use fake GitHub/trigger/agent adapters and no paid inference.
- No automatic merge, production deployment, architectural expansion outside approval, autonomous policy changes or extra cloud infrastructure.

## Cloud compatibility requirements

Ordinary single-repository cloud sessions load committed `.claude/skills/`, `.claude/agents/`, `.claude/settings.json` hooks and permission rules. Local home-directory configuration does not follow the session. Repository `enabledPlugins`/marketplace declarations do not install plugins automatically. Therefore a local Rig installation cannot simply be assumed to exist in the cloud.

Implement a versioned cloud profile using repository-local skills/hooks and vendored Rig scripts, or another explicitly supported installation path proved in the smoke test. Preserve license/provenance and keep local installs unchanged. Use the environment setup script for toolchains, and SessionStart for repeatable project setup. Avoid dependence on `${CLAUDE_PLUGIN_ROOT}` unless the actual cloud loading mechanism provides it; otherwise resolve the vendored repository path.

Claude Projects threads are a different surface: repository settings hooks do not run and repository skills/plugins are not loaded in the same way. A future Projects adapter needs separate account/project plugin configuration and verification. Do not select Projects merely because it can coordinate sessions and assume Rig protections survive.

## Planning artifacts and first checkpoint

Reuse Rig's pinned chart/intent/spec/plan formats. The target contains:

```text
.factory/config.json
.factory/runs/<run-id>/{manifest.json,review-guide.md,questions.json}
.rig/product/sprints/sprint-<N>/{source.md,prd.md,requirements.md}
.rig/product/sprints/sprint-<N>/intents/**
.rig/product/sprints/sprint-<N>/{implementation-plan.md,testplan/**}
.rig/product/architecture.md
.rig/product/adrs/**
.rig/changes/<slug>/{spec.md,plan.md,plan-review.md}
```

Confirm actual Rig chart paths from its pinned source before implementing the adapter; record the mapping rather than generating a second competing intent format. The factory manifest binds source/policy revisions, canonical artifact hashes, all requirement/acceptance-case mappings, intent dependencies, allowed paths, interfaces and explicit assumptions.

The planning cloud task generates the complete package without product-code changes. An AFK entry point records unanswered material questions rather than fabricating business decisions or entering a conversational approval loop. Deterministic validation and a separate planning review check source fidelity, missing requirements, numerical rules, dependency cycles, all intent plans and executable verification commands.

The human reviews one planning PR, approves its current head and merges the package. A trusted GitHub job verifies actual current-head review/merge evidence, final artifact hashes and approved human identities. It persists immutable batch authorization. Every included unchanged spec/plan is authorized; there is no routine `/rig:approve` per intent.

**Identity must be proved:** native scheduled-task actions can carry the connected user's GitHub identity. A solo operator cannot rely on independently reviewing a PR authored as that same user. Prefer letting cloud sessions push candidate branches, then have a narrowly scoped GitHub App publisher create planning and implementation PRs as the bot. Test actual branch/PR attribution before committing to this gate. Do not manufacture independent human reviews or silently enable bypass rules.

## Native cloud orchestration

Create dedicated planning, implementation and automated-review cloud tasks through supported Claude configuration. The task's saved prompt contains the trusted workflow; its API payload supplies identifiers and references only. A trigger token authorizes starting that task, not approving product work.

GitHub Actions stores the routine fire URL/token as a secret and calls the documented endpoint after validating authorization and ready work. It stores the returned session ID/URL with the attempt. The API is research preview; version its dated beta header and test request/response compatibility. Do not invent a general session create/status/cancel API or use undocumented internal endpoints.

Normal cloud launch can also be demonstrated with `claude --cloud` from a pushed checkout. `claude -p` running on an Actions runner is a different execution path. A follow-up send that queues a message is not evidence of cloud task completion.

Operational state is compact JSON on protected `factory-state`, written only by trusted controller code through parent-bound, non-force Git updates. It contains intake, approval snapshots, reservations, task/attempt/session identity, deterministic branch/PR identity, pause/revocation and terminal outcomes. Concurrent sibling updates fail and reload. Issues project status; labels/comments alone never establish approval or completion.

The cloud task reads the exact approved package and assignment and pushes a candidate branch/result manifest. The controller treats all candidate manifests as untrusted. It refetches branch commits, re-runs checks and matches scope before publication. Native session status observed in the UI can help an operator, but machine completion requires verified repository/CI evidence.

An ambiguous trigger timeout does not permit another paid session automatically. Preserve an `unknown-launch` state and reconcile available evidence; if supported APIs cannot establish nonlaunch, pause rather than duplicate. Do not claim the routine fire API has idempotency, cancellation or concurrency guarantees not documented or tested.

## Build, verification, repair and final checkpoint

Select only intents with human-merged prerequisite PRs. PR creation, an issue being closed or the cloud agent declaring success does not release dependents. Start from current base after dependencies merge, run baseline checks, accept compatible unrelated base movement, and block unresolved overlapping contract/scope changes for replan.

Cloud Rig builds within the batch-approved spec/plan. Local hooks provide feedback; external CI proves scope, contracts, test behavior, secret checks, required checks and exact-head verification. A separate cloud review task assesses the exact diff using trusted review instructions and structured code/security findings. Missing/malformed reviews and unverifiable required behavior block readiness. Repairs share a two-pass allowance; changed candidate heads invalidate previous checks/reviews.

The App publisher validates approval, branch scope, unsafe paths, exact candidate identity and passing evidence, then creates/updates one PR per intent. It never executes target source in its credentialed job. Required status checks and branch rules bind to the expected App where supported. No automation merge, auto-merge or approving-review action is configured.

A human reviews and merges each implementation PR. A fresh live merge lookup releases successors. After all intents merge, conventional CI runs full-PRD acceptance on the integrated base. Failure produces a blocked acceptance report and proposed correction; it does not admit unapproved work.

## Rig changes required

1. Cloud profile with vendored scripts, repository-local skills, working paths and verified hook registration.
2. AFK planning that generates every per-intent spec/plan before the batch checkpoint.
3. Central approval resolver that accepts exact factory batch authorization in addition to existing standalone human approval. All lifecycle/build/contract/PR checks use it; no fake `approval.json`, `SDLC_HUMAN=1` in agent scripts, or globally disabled plan gate.
4. Candidate-only closeout for the cloud workflow: push candidate/evidence, then let bot publication create the reviewable PR.
5. Exception reports and bounded repair behavior without additional routine approvals.

The worker can read a package/context but cannot create authoritative approval. Signed authorization is optional defense-in-depth, not a new hosted service; CI revalidates authoritative GitHub facts regardless. Protected policy comes from the approved base or pinned harness revision, never candidate modifications.

## Limits and operations

Cloud sessions and native tasks consume the user's Claude plan limits. Native task APIs/triggers are research preview and can rate-limit or drop events. Routines can still stop at permission prompts. Test supported behavior instead of promising exactly two total interactions under every failure.

Do not retain the superseded Actions/API-engine dollar-cap assumptions as guaranteed cloud controls. Initial enforceable factory limits are one active assignment, three open PRs, two repair passes, bounded trigger attempts and explicit pause/revocation. Set native usage/overage policy in Claude account settings. Add monetary/session-time admission controls only where supported telemetry/control has been demonstrated; report unknown spend/runtime honestly.

Cancellation first revokes authorization and blocks publication/admission, then uses supported native task/session UI controls to stop execution. Do not assert immediate programmatic termination until a supported API is verified. A watchdog may stop accepting results without necessarily stopping compute.

Onboarding is separate setup: create/protect target default and state branches, install the Claude GitHub connection and App publisher, configure cloud environment and tasks, review vendored Rig profile, establish real test commands and branch rules. An empty target gets a reviewed walking skeleton before PRD execution.

## Acceptance criteria

- AC-01: Actual implementation work executes in native Claude Code cloud sessions with the laptop offline.
- AC-02: Cloud Rig skills/scripts/hooks are observed working; a deliberate violation is caught externally even if local feedback is bypassed.
- AC-03: PRD produces complete architecture/intents/specs/plans/test strategy before one human package approval.
- AC-04: No product build before current-head human approval and merge; no routine per-intent approval after it.
- AC-05: Scope drift and unresolved business questions block affected work.
- AC-06: Ready PRs have exact-head independent checks and fresh automated reviews.
- AC-07: Dependencies release only on human merges; all implementation PRs retain the human gate with valid author/reviewer identity.
- AC-08: Duplicate events and ambiguous launches/publications cannot silently duplicate PRs or authorize stale work.
- AC-09: Limits, permission stops, revocation and native API limitations are visible and operationally tested.
- AC-10: Integrated acceptance passes before completion; both scripted proof and separately authorized live pilot exist.

References: [Claude Code cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [cloud environment loading](https://code.claude.com/docs/en/cloud-environments), [native scheduled tasks](https://code.claude.com/docs/en/routines), [Projects differences](https://code.claude.com/docs/en/claude-projects), [Rig source](https://github.com/cwijayasundara/rig_v1/tree/f33015bf12e711be7441eca45fefb177fd5d81cc), [Addy Osmani's article](https://addyosmani.com/blog/software-factories/).
