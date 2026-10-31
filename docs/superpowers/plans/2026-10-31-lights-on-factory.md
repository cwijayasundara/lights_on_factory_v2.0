# Lights On Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task, or superpowers:subagent-driven-development only if the user selects delegation. Steps use checkbox (`- [ ]`) syntax. This document is a plan; no implementation or deployment has been authorized by writing it.

**Goal:** Feed a PRD into native Claude Code cloud with a cloud-compatible Rig profile, approve its complete architecture/intent package once, and receive verified PRs for human review and merge.

**Architecture:** Anthropic hosts Claude Code sessions. Rig supplies the engineering workflow. Native cloud task triggers start planning/build/review sessions, and small deterministic GitHub Actions jobs verify authorization, schedule merge-ready intents, run CI and publish PRs as a bot. Operational records live on a protected Git branch; no new cloud server or database is required.

**Tech Stack:** Native Claude Code cloud environments and scheduled tasks/routines, pinned Rig scripts and repository-local skills/hooks, GitHub Actions/App, Node.js 24 LTS, erasable TypeScript, npm, Zod, Octokit and Node tests.

**Spec:** [Native cloud design](../specs/2026-10-31-lights-on-factory-design.md).

**Status:** Draft revised after the user clarified native Claude cloud hosting. Supersedes the Actions-hosted gh-aw and AWS drafts.

## Global Constraints

- Coding compute runs in native Claude Code cloud sessions, not an Actions `claude -p` process.
- Two planned checkpoints: one human approval of the complete package; human review and merge of every implementation PR.
- No product-code worker before current-head package approval/merge; no routine per-intent approvals after it.
- One target repository, one active PRD and one active implementation assignment initially.
- Maximum three open implementation PRs, two repair passes and two confirmed-nonlaunch trigger retries.
- No automatic merge, deployment, scope expansion, fake approvals or global disabling of Rig gates.
- Use ordinary single-repository cloud sessions outside Projects threads for the compatibility target.
- Pin verified Rig/runtime revisions. Preserve standalone Rig behavior.
- Rig is a separate harness that the factory applies to target repositories. This repository is never a Rig target and keeps no copy of Rig's source. Rig changes the factory needs go upstream to rig_v1 as their own reviewed changes, then reach this repository by bumping the pin in `cloud/rig-profile/pin.json`.
- Controller reconciliation is configured every five minutes, not guaranteed to run within five minutes.
- Evidence retention is 90 days where supported; durable approval/result records persist in Git.
- No unsupported session APIs, guaranteed dollar caps, cancellation guarantees or assumptions about routine-fire idempotency.
- Normal tests require no paid model access or cloud credentials.

## Review Focus

1. Cloud skills may load while the plugin's enforcement hooks do not: Task 1 observes both and Task 6 proves external enforcement.
2. A native task can act under the human's GitHub identity, making solo self-review invalid: Task 2 proves bot publication and human gate compatibility.
3. Approval on an old plan head or a changed artifact cannot authorize code: Task 4 binds GitHub evidence to package hashes.
4. A timed-out trigger request can already have launched paid work: Task 5 retains unknown-launch state and forbids blind replay.
5. PR delivery, issue closure and agent completion are not human merges: Task 7 verifies live predecessor merge evidence and integrated acceptance.

## Proposed file map

```text
package.json, package-lock.json, tsconfig.json
src/{contracts,package,approval,state,triggers,verification,publication,reconcile,cli}.ts
cloud/{environment-setup.sh,planning-task.md,build-task.md,review-task.md}
cloud/rig-profile/{settings.json,skills/**}  # templates, not an installed profile
templates/{config.json,manifest.json,pr-body.md}
workflows/{controller,verify,publish,ci}.yml
scripts/{install-cloud-profile,demo}.ts
tests/{unit,contract,integration,e2e}/*.test.ts
tests/helpers/{fixtures,fakes}.ts
tests/fixtures/{prd,packages,reviews,candidates}/**
docs/{cloud-compatibility,onboarding,operations,acceptance-pilot}.md
```

Task 1 identifies exact vendored Rig files and substitutions from the pinned rig_v1 commit. Rig source changes go upstream in rig_v1, then the pin is bumped here; repository cloud-profile templates belong here. Source helpers and workflow templates are installed into target repositories from the pinned commit, never from candidate-modified files.

## Interfaces to establish in Task 3

`PackageManifest` binds `runId`, `revision`, `repoId`, `sourceSha`, `sourceDigest`, `policyDigest`, canonical `{path, sha256}` artifacts and intent records. An intent has `id`, `slug`, `dependsOn`, `requirementIds`, `specPath`, `planPath`, `allowedPaths`, `contractPaths` and `checkIds`. The manifest also records requirement-to-acceptance-case coverage and material questions. Hashes are full SHA-256 values.

`Authorization` binds package digest, planning PR, reviewed head, final merged artifacts, human reviewer/merge actor and policy revision. `Candidate` binds run/intent/attempt/session identity, base/head SHA, branch, result manifest and evidence references. Runtime schemas reject extra authority fields supplied by model output.

`StateStore.read(): Promise<{tipSha: string; state: FactoryState}>`; `StateStore.commit(expectedTip: string, next: FactoryState): Promise<'committed'|'conflict'>` creates a child of the observed tip and advances with `force: false`. A conflict reloads/rechecks. The state includes authorizations, revocations, assignments, trigger outcomes, session references, repair counts, PR mapping and terminal evidence.

`CloudTrigger.fire(task: 'plan'|'build'|'review', assignment: Assignment): Promise<TriggerOutcome>` returns `accepted` with session ID/URL, `rejected` with documented error, or `unknown` after an ambiguous request. `Assignment` is identifiers and approved references, not arbitrary shell/prompt authority.

`GitHubGateway` exposes typed source/review/check/branch/PR reads, bot PR publication/update, state Git operations and status updates. No merge, auto-merge or approving-review method. `CheckReport` and schema-validated `ReviewReport` always carry the exact candidate SHA. Inject clock/IDs/adapters for deterministic tests.

### Task 1: Prove Rig runs and enforces its profile in native cloud

**Files:** Create `docs/cloud-compatibility.md`, `cloud/environment-setup.sh`, cloud-profile templates and `scripts/install-cloud-profile.ts`; inspect `scripts/{sdlc,core,hooks,lifecycle,check,pr}.ts` and `skills/{chart,plan,build,pr}/SKILL.md` at the pinned rig_v1 commit (`.cache/rig/<commit>`) before assigning edits. Profile tests install into temporary target repositories, never into this one.

**Produces:** A pinned cloud artifact map, path resolution strategy and observable hook/skill compatibility evidence.

- [ ] Inspect the pinned Rig checkout and document every dependency on plugin installation, `CLAUDE_PLUGIN_ROOT`, local home settings and interactive skills. Check the current native-cloud loading rules against the design's compatibility section.
- [ ] Build the minimum repository-local profile: vendored checker/helpers, explicit skills, settings hooks and idempotent project startup. Use environment setup for toolchains; do not depend on untransferred local settings or repository plugin auto-installation.
- [ ] Add meaningful scripted profile tests: generated hook commands resolve in a fresh clone; expected skills are present; missing checker/toolchain fails visibly; a deliberate forbidden edit yields a failed checker result.
- [ ] In a separately authorized disposable native cloud session, observe loaded skills, SessionStart/edit/stop hooks, script execution, test tooling and a deliberate violation. Record actual CLI/Rig revisions and what did not load. Do not use a Projects thread for this proof.
- [ ] Run profile tests and record native evidence in `docs/cloud-compatibility.md`. Stop architectural rollout if core enforcement cannot be made observable; propose a supported loading adjustment rather than claiming portability. Commit as `feat: add a verified native-cloud Rig profile` during execution.

### Task 2: Prove native triggering, attribution and publication feasibility

**Files:** Create `cloud/{planning-task,build-task,review-task}.md`, `docs/onboarding.md` and `tests/contract/cloud-trigger.test.ts`.

**Produces:** Versioned trigger request/response mapping, task configuration checklist and verified PR author/reviewer path.

- [ ] Define saved task prompts that consume assignment identifiers, fetch approved artifacts, use Rig cloud entry points and stop on missing authority. Exclude unneeded connectors. Missing business decisions become structured questions.
- [ ] Write trigger contract fixtures for accepted session ID/URL, documented rejection, rate limiting, schema drift and timeout-after-send. Run `node --test tests/contract/cloud-trigger.test.ts`; require all fixture outcomes to remain distinct.
- [ ] Configure native tasks and their API triggers only during authorized setup; token creation is a documented UI step. Store tokens in GitHub Secrets. Pin the documented dated API header; do not request ordinary API credentials as a substitute for the native task token.
- [ ] Prove a triggered task runs with the laptop offline and can push a candidate branch. Observe actual commit/PR authorship and GitHub proxy/tool permissions. Determine whether programmatic PR creation is exposed; do not assume a UI PR button is the same as an unattended API path.
- [ ] Prove a trusted GitHub App publisher can open a PR from that candidate branch and the intended human can approve/merge it under real branch rules. Record supported stop/status surfaces and unavailable APIs. Commit documentation/fixtures as `test: establish native-cloud trigger and human-gate contracts`.

### Task 3: Frozen intake, complete package schema and Git state

**Files:** Create project configuration, `src/{contracts,package,state,cli}.ts`, test helpers, fixtures, `scripts/demo.ts`, and `tests/integration/planning.test.ts`.

**Interfaces:** Implement the shared contracts and `validatePackage(manifest: PackageManifest, source: SourceSnapshot, artifacts: ArtifactReader): Finding[]`; `submitPrd(input: SubmitInput, deps: Dependencies): Promise<RunRecord>` freezes pushed source bytes and idempotency key.

- [ ] Write failing tests for omitted requirements, altered numeric acceptance values, missing architecture/spec/plan, cycles, unanswered material questions, escaping attachment paths, and source edits after intake. Assert intake produces no product build.
- [ ] Add a valid three-intent fixture: catalog, cart depending on catalog, and an independent health endpoint. Assert every requirement/test mapping and all per-intent artifacts exist before the package becomes approval-ready.
- [ ] Test two concurrent state writers from one tip: only one update succeeds; the other reloads/rechecks with no forced update or lost authorization. Test duplicate intake returns one run.
- [ ] Run `node --test tests/integration/planning.test.ts` and confirm failure, then implement schemas, source/artifact digests, integrity checks, state storage and fake adapters. Semantic planning review supplements structural checks; source-line coverage alone is not proof of faithful interpretation.
- [ ] Define `npm test`, `npm run typecheck`, `npm run test:integration`, `npm run test:e2e:scripted`. Rerun tests/typecheck and scripted demo. Commit as `feat: freeze PRDs and validate complete planning packages`.

### Task 4: Batch authorization and AFK Rig lifecycle

**Files:** Create `src/approval.ts`, `tests/integration/approval.test.ts` here. Upstream in rig_v1, as its own change: add `scripts/factorycontext.ts` and tests, refactor existing lifecycle/check/contract/PR approval consumers, and add cloud planning/build entry points. Then bump the pin here.

**Interfaces:** `authorizePlan(repo: Repo, pr: number, deps: Dependencies): Promise<Authorization>`; Rig `resolveApproval(slug: string, context?: FactoryContext): ApprovalResolution` returns `local-human`, `factory-batch` or `missing`.

- [ ] Write failing tests: bot/comment/label-only or stale/dismissed approval cannot authorize; wrong merged artifacts or human identity fails; one valid human-approved merged package authorizes all unchanged specs/plans with no per-intent prompts.
- [ ] Add Rig tests for changed spec/plan/contract, wrong intent/repository and missing context. Absence of factory context preserves standalone behavior. Assert no model path writes `approval.json`, sets `SDLC_HUMAN`, or disables plan gates globally.
- [ ] Run focused tests and confirm failure. Implement immutable GitHub-based batch authorization and one central Rig resolver, then AFK chart/per-intent planning that completes the package before approval. Keep all scope/contract checks active.
- [ ] Add candidate-only cloud closeout and exception reports. Local context cannot create authority: independent CI revalidates GitHub evidence and approved hashes. Run Rig's tests/typecheck in rig_v1 and the factory approval tests here. Merge the Rig change upstream in rig_v1, then bump the pin in this repository and rerun the profile tests against temporary targets.

### Task 5: Deterministic native-cloud assignment and trigger handling

**Files:** Create `src/triggers.ts`, `workflows/controller.yml`, and `tests/integration/dispatch.test.ts`.

**Interfaces:** `dispatchReady(runId: string, deps: Dependencies): Promise<DispatchDecision>` uses the `CloudTrigger` contract and persists an assignment before calling the endpoint.

- [ ] Write failing tests: unapproved/revoked packages cannot dispatch; cart waits for a human catalog merge; closing its issue or opening its PR is insufficient; a fourth open implementation PR is blocked; two schedulers cannot create two active assignments.
- [ ] Test accepted, rejected and unknown launches. A timeout after send preserves `unknown-launch` and cannot trigger another session unless nonlaunch is confirmed. Two retries are the absolute confirmed-nonlaunch maximum, not a generic HTTP retry policy.
- [ ] Run `node --test tests/integration/dispatch.test.ts`; confirm failure, then implement live merge readiness, current-base/scope compatibility checks, one-assignment reservation, trigger calls, session IDs/URLs and explicit waiting reasons.
- [ ] Keep saved routine prompts authoritative; fire text is only assignment data. Do not infer completion from a successful trigger or queued follow-up. Rerun tests. Commit as `feat: dispatch authorized work to native Claude cloud`.

### Task 6: Independent CI, review and bot PR publication

**Files:** Create `src/{verification,publication}.ts`, `workflows/{verify,publish}.yml`, `templates/pr-body.md`, and `tests/integration/verification-publication.test.ts`.

**Interfaces:** `verifyCandidate(candidate: Candidate, checks: CheckReport, reviews: ReviewReport[], deps: Dependencies): Decision`; `publishVerified(candidate: Candidate, deps: Dependencies): Promise<PullIdentity>`.

- [ ] Write failing tests for a forged worker result, passing builder tests but failed independent acceptance, missing check, malformed review, mismatched SHA, high/critical finding and out-of-scope protected file. All block ready publication.
- [ ] Test candidate changes invalidate previous checks/reviews; only two repair passes are allowed. Test duplicate/lost PR creation response reuses the existing deterministic branch/PR. Reject escaping paths, unsafe symlinks and `.git` changes.
- [ ] Run the focused suite and confirm failure. Implement external deterministic checks from trusted policy plus separate native-cloud automated review of the exact candidate. Treat all candidate files/results as untrusted data.
- [ ] Implement bot publication without executing source in the token-bearing job. PR bodies link requirements, architecture, evidence and head SHA. No merge/auto-merge/approving-review path exists. A bot-authored planning PR uses the same attribution discipline.
- [ ] Rerun tests; demonstrate a local-harness bypass is still blocked by CI. Commit as `feat: publish independently verified PRs through a bot identity`.

### Task 7: Reconcile, bound exceptions and verify integrated acceptance

**Files:** Create `src/reconcile.ts`, `docs/operations.md`, and `tests/integration/recovery.test.ts`.

**Interfaces:** `reconcileRun(runId: string, deps: Dependencies): Promise<RunSummary>` and `completeDelivery(runId: string, deps: Dependencies): Promise<CompletionDecision>`.

- [ ] Write failing cases for missed GitHub events, expired cloud environments, permission stops, unknown launch, rejected PRs, changed PR heads, cancelled runs and duplicate events. Assertions require explicit state/reason and no false completion or duplicate ready PR.
- [ ] Assert every dependency uses live human merge evidence; all merged intents still require full-PRD acceptance on the integrated base. A failing final suite creates a blocked report, not automatic unauthorized corrective work.
- [ ] Implement event-driven reconciliation plus a five-minute configured schedule and manual dispatch fallback. Record session URLs for operator diagnosis without inventing native session status/cancel APIs.
- [ ] Revocation immediately blocks new work/publication; stopping already-running native compute uses only supported controls. Document the difference. Track assignment/repair/concurrency limits and actual account usage controls; do not claim hard API-dollar caps from the superseded design.
- [ ] Run `node --test tests/integration/recovery.test.ts` and scripted demonstration. Commit as `feat: reconcile cloud delivery and expose actionable exceptions`.

### Task 8: End-to-end proof and operating handoff

**Files:** Create `tests/e2e/factory.test.ts`, `workflows/ci.yml`, `docs/acceptance-pilot.md`, and finalize onboarding/operations.

**Interfaces:** `npm run test:e2e:scripted` requires no credentials. Live pilot is separately invoked in an explicitly selected disposable repository.

- [ ] Script the three-intent journey: PRD -> all architecture/intents/specs/plans -> one valid human package approval/merge -> automatic native-task assignments -> checked bot PRs -> human merges -> integrated acceptance. Count zero routine per-intent plan approvals.
- [ ] Include negative journeys for incomplete PRD, stale approval, harness not loaded, unknown trigger, scope change, malformed review, repeated repair, refused permission, rejected PR and failed final acceptance. Record expected reasons.
- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:integration` and `npm run test:e2e:scripted`; require zero failures and verify workflow templates contain no auto-merge or replacement runtime.
- [ ] During authorized live setup, prove AC-01 through AC-10 in the disposable repository. Human approves the package and implementation PRs; laptop is offline during build. Intentionally fail a check and trigger a scope exception.
- [ ] Record package/source hashes, cloud session URLs, loaded Rig revision, hook evidence, bot/human identities, PR/check URLs, actual permission interruptions, usage observations and integrated acceptance SHA. Distinguish tested behavior from provider/API limitations.
- [ ] Provide a dry-run installation checklist covering Claude GitHub access, native cloud tasks, bot publisher, repository/state protections and recovery. No external cloud provisioning. Commit as `test: prove native-cloud lights-on factory delivery` after the checks actually run.

## Coverage and completion

AC-01 native cloud/laptop-offline: Tasks 1, 2, 8. AC-02 harness and external enforcement: 1, 4, 6. AC-03 complete package: 3, 4, 8. AC-04 single batch gate: 4, 5, 8. AC-05 scope/questions: 3, 4, 6. AC-06 exact-head evidence: 6, 8. AC-07 human merges/identity: 2, 5, 6, 7. AC-08 recovery: 3, 5, 6, 7. AC-09 limits/native caveats: 2, 5, 7, 8. AC-10 integrated/scripted/live acceptance: 7, 8.

This plan retains Claude Code and Rig. gh-aw and Pi remain researched alternatives rather than v1 dependencies. The first deliverable is a native-cloud Rig compatibility proof; a universal replacement or stronger capability has not been established by research alone.
