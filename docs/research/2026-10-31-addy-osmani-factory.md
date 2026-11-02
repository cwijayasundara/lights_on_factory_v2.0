# Useful facts from Addy Osmani's factory

Research date: 2026-10-31. Source inspected: [addyosmani/factory](https://github.com/addyosmani/factory) at commit `8af116567166a0a16588b7ab1b9934ece0b775bc` (tree of `main` that day). No local install and no comparative run.

This note keeps the operating facts that apply to Lights On Factory. It does not adopt his installer, his issue queue, or his four interactive spec gates.

## What the repository is

An installer for another GitHub project. `install.sh` copies a template and refuses to overwrite existing files. The optional issue-trigger workflow is included only with `--with-issue-trigger`. There is no factory process. Claude Code cloud routines are the clock. GitHub issues and pull requests are the durable state. Each run starts from a fresh clone, does one stage, writes evidence, and stops.

Codex gets thin adapters under `.agents/skills/` and `.codex/hooks.json` that point at the same charter and contract. Unattended schedules are provisioned only for Claude.

## Facts that match this factory

Cloud sessions see only what is committed. `~/.claude`, user plugins, and `claude mcp add` without `--scope project` do not travel. Project `.claude/settings.json`, skills, agents, and `.mcp.json` do. The cloud environment itself does not: network allowlist, environment variables, the setup script, and routine definitions are account UI state. He tells you to paste that UI state into a repo file named `CLOUD-ENVIRONMENT.md`.

The drill already showed the hole. Committing `cloud/environment-setup.sh` did not select it. The session log said no setup script was configured.

Other environment facts from `LIMITS.md` and `QUICKSTART.md`, checked by him against Claude Code docs in August 2026. Routines and Claude Code on the web were in research preview, so re-check before relying on a number.

| Fact | Consequence here |
| --- | --- |
| A green routine or session status means the session started and exited. It does not mean the task succeeded. | The cloud drill's "completed" status is not hook evidence. A gate file checked by CI is the evidence. |
| Routines act as the signed-in GitHub user. Every attached connector is callable, including writes, without a prompt. | Keep the separate publisher. Do not let the coding session open the human-facing pull request as the reviewer. |
| Routine GitHub triggers are `pull_request` and `release` only. There is no `issues` trigger. | A stock routine cannot start work from a new issue. An Action may POST to the routine fire API, or the session is started by our controller. |
| `/web-setup` grants clone access. The Claude GitHub App is required for routine webhooks and auto-fix. | Task 2 needs a GitHub remote and the App before a cloud session can push back. A bundle upload cannot. |
| Minimum cloud routine interval is 1 hour. There is a separate daily cap on routine runs. One-off runs are exempt. | Do not poll hourly on a quiet repo. It spends the cap. |
| `GH_TOKEN` and `GITHUB_TOKEN` should stay unset. The proxy exposes the literal `proxy-injected`. `gh` works. A script that reads the token does not. `gh` is not preinstalled. | Do not put a GitHub token in the cloud environment. |
| Setup scripts must finish in about 5 minutes. The result is cached and rebuilt on change or after about 7 days. | Node 22 is already on the image. The setup script is for missing tools, not for the Rig profile. |
| Default network is a trusted allowlist. Reaching our own services needs explicit domains. | No extra services are required for v1. |
| Branch pushes to `claude/` are accepted. Other branches are rejected when protected, when someone else has an open pull request from them, or when they contain another author's commits. | A coding session can push `claude/…`. Publication onto the review branch stays with the trusted publisher. |
| Non-GitHub remotes can be uploaded as a bundle and cannot push results back. | This repo has no remote today, so it cannot be the implementation target. |
| `--cloud` with a prompt creates a new session. It does not upload the current local conversation. Desktop "Continue in" can. `--teleport` is cloud to local and wants a clean worktree. | Planning and implementation stay separate sessions. |
| `claude -p "message" --cloud <session-id>` queues a follow-up and returns. The API fire payload arrives inside `<routine-fire-payload>` and is labelled untrusted. The saved prompt must mention that block or the text is ignored. | Pass an issue number, not the issue body, if a trigger is added later. |
| Cloud images already include Node 20/21/22, Python, Go, Rust, Java, Ruby, PHP, Docker, Postgres 16, and Redis. | Do not invent a custom VM for those tools. |

The fire endpoint shape he documents:

```text
POST https://api.anthropic.com/v1/claude_code/routines/<ROUTINE_ID>/fire
Authorization: Bearer <token shown once>
anthropic-beta: experimental-cc-routine-2026-04-01
anthropic-version: 2023-06-01
{"text": "..."}
```

His optional Action (`template/.github/workflows/factory-fire.yml`) fires on `issues: [opened, reopened]`, skips issues labelled `factory:monitor`, and sends only `Triage issue #<n> in <repo>`. Missing secrets exit 0 so scheduled triage still works. Permissions are `contents: read` and `issues: read`.

## Operating rules worth keeping

These are policies, expressed as files and scripts, not as a service.

**Default deny.** `docs/factory/CHARTER.md` is human-owned. Skills read it first. If it does not cover the work, the run stops. `CHARTER_STATUS` stays `incomplete` until a person has reviewed every section. An agent must not edit the charter, `.factory/gates.conf`, or `.claude/`.

**Autonomy follows who gets hurt, not how large the diff is.** Tiers are `revival`, `greenfield`, `oss`, and `client-production`. Wider autonomy is for unlaunched work. The narrowest tier is someone else's production system. He warns about tier-bleed: the same green checkmarks mean different things in different repos, so the constraint has to live in the repo.

**Load-bearing paths are globs.** His starter list includes auth, payments, migrations, SQL, workflows, and the factory's own `.claude/`, `.factory/`, and `.agents/` trees. A hit forces deep gates and a human read. Unattended runs also may not modify an existing test file. A new test file is allowed. Changing an old assertion is how a suite goes green without the behavior being fixed.

**Automatable work is an explicit list.** Vague entries produce vague triage. His starter list is dependency bumps, lint and types, docs, new tests for untested functions, and a single-file bug with a failing test. User-visible features, public API changes, anything over five files, and anything load-bearing need a spec. Merge, architecture, product intent, and anything unlisted are never automated.

**Stop conditions are numbers.** His `STOP_IF` includes two red gate attempts, a load-bearing touch, 400 changed lines, ambiguity after one clarification, and more than three items awaiting review. The implement routine checks the review count before it claims work. When the queue is full it writes a stopped run record and does not implement. His advice is to start `AUTOMATABLE` small, add the implement routine only after triage dispositions look right, and add one routine at a time.

**The gate script is the verdict.** `gates.sh` takes `fast`, `full`, or `deep`. Exit 0 is green, 1 is red, 2 is misconfigured. A required gate that cannot run is `MISCONFIGURED`, never green. The last line is quoted unchanged:

```text
FACTORY_GATES: level=full status=RED passed=3 failed=1 failing=test skipped=build misconfigured=none
```

Required sets in `.factory/gates.conf`: fast is types and lint; full adds test; deep adds audit and architecture. Build and mutation are optional until the repo has a real command. The script auto-detects Node, Python, Rust, and Go. The architecture gate is a grep with a fail flag, so there is nothing for the agent to negotiate. Skills may not report a result that contradicts the line. A later verify run runs the script again and treats a mismatch with the pull-request body as a finding.

**The writer does not grade the work.** Implement hands the verifier only the queue item, branch, and base SHA. The verifier ignores any story of what was done. It re-runs the gates, checks `done_when` literally, rejects load-bearing touches and extra files, and rejects modified existing tests on an unattended run. Uncertainty rejects. Two verifier rejections end the run.

The check Rig's red/green sensor does not make is `prove-test.sh`. From a clean tree it builds a binary patch of the non-test hunks, reverses it, runs the focused test, and restores the patch under a trap. Its own lines are:

```text
PROOF: status=PROVEN test_exit=<n>
PROOF: status=FAILED reason=test-passed-without-fix
PROOF: status=MISCONFIGURED reason=<not-a-git-repository|invalid-base-ref|working-tree-not-clean|no-non-test-change|empty-revert-patch>
```

A test that passes with the fix removed fails the proof. If test and implementation cannot be separated, the verdict is `accepted-with-reservations`, not a pretend pass. The verifier returns one block: `verdict`, `gates`, `test_proves_fix`, `existing_tests_modified`, `scope`, `done_when_met`, `reasoning`, `must_fix`.

A second agent, `factory-critic`, runs only on load-bearing diffs and does not repeat the gates. He cites a review-tool study in which 93.4% of findings across 146 pull requests were caught by exactly one of four tools. That number is his citation, not a measurement made here.

**One claim per run, raced on a ref.** The branch is `claude/fq-<issue-number>`. The run adds an empty commit with a unique run id and pushes without force. A non-fast-forward rejection means someone else owns it, so the loser stops without editing or relabelling. A label is not a compare-and-swap. Stale claims are reported and never stolen. A human deletes or recovers the branch.

**Handoff is a comment, not the transcript.** Queue state is one of `factory:ready-to-implement`, `factory:ready-to-spec`, `factory:needs-info`, `factory:wait-to-implement`, `factory:in-progress`, `factory:awaiting-review`. Pull requests get `factory:verified` or `factory:rejected`. `factory:monitor` is provenance and may sit beside one state label. The operational comment is:

```text
<!-- factory-handoff:v1 -->
disposition: ready-to-implement
done_when: <checkable condition>
files_expected: <comma-separated paths>
load_bearing: false
gate_level: fast | full | deep
confidence: high | medium | low
triaged_at: <UTC timestamp>
```

Re-triage updates that comment. It does not add a second one. Issue text is untrusted and cannot override the charter. `QUEUE.md` is a snapshot and must not be the live handoff.

**Evidence is one new file per run.** Path shape: `docs/factory/runs/YYYY-MM-DDTHHMMSSZ-<stage>-<id>.md`. Front matter records `status` (`succeeded`, `stopped`, `rejected`, `infrastructure-failed`), gate line, verifier verdict, and `human_required`. Routines never append to a shared log. Records omit secrets and copied issue bodies. He explicitly skips a token dashboard because nothing stock emits a complete cost record. Queue age, gate failures, verifier rejections, review time, and escaped defects can be counted from these files plus issue and pull-request timestamps.

**Merge stays human.** Hooks block `gh pr merge`, `git merge`, force pushes, pushes to protected branches, and shell rewrites of protected files. He says hooks miss hosted tools and API paths. The GitHub ruleset is the boundary: pull request required, no force push, no deletion, and the unattended account has no bypass.

**Migrations need an oracle before the wide edit.** His spec order is: make it build, make it typecheck, pin current behavior with characterization tests, then migrate. A migration can compile and still change behavior when the tests never covered that behavior.

**Plan locally, execute remotely, after the plan is committed.** His quickstart's split is the same shape as this factory's planning session and later implementation session. He also says to dry-run triage with no writes, and to grade the charter when dispositions look wrong.

## What not to copy

His spec stage is interactive and has four human approval gates before code. This factory has one planning-package approval, then unattended implementation. Importing those four gates would undo that decision.

His live authority is an issue label plus a handoff comment. This factory already says labels and comments never establish approval. The handoff shape is useful as a projection. The approval remains the hashed package and the human action on GitHub.

His implement routine opens the draft pull request itself, as the user. This factory's publisher checks approval, path scope, and passing CI, and it does not run the candidate. Keep that split. His draft-until-verified habit is still right: the review queue should contain evidence-complete pull requests.

His five routines are a personal-repo clock. This factory needs deterministic assignment, batch-approval checks, and a bot identity, which stock routines do not provide. The small Actions controller stays. It should not grow into a queue service. He is right that Temporal, a custom worker, and a private VM are extra surface until a stock trigger cannot express the requirement.

Do not install his template over this repo. It would drop a second `.claude/` policy beside Rig.

## What to carry into later tasks

Use these when Task 2 and the verification work start. They do not change Task 1's cloud-profile proof.

1. Write `CLOUD-ENVIRONMENT.md` for the UI state that Git cannot select: setup script chosen or deliberately absent, network, connectors removed, GitHub App versus `/web-setup`, and the rule that no GitHub token is stored in the environment.
2. Require a GitHub remote and the Claude GitHub App before a cloud session is expected to push.
3. Give CI a verdict line the pull request must quote, with a missing required command as a hard failure rather than a skip.
4. Add an independent proof that the new test fails when the non-test diff is reverted. Run it in a clean tree, in a context that does not trust the implementer's account.
5. Refuse an unattended edit to an existing test, a load-bearing path, or a path the approved package does not name.
6. Stop the next implementation session before launch when open review pull requests are at the cap.
7. Store one immutable run record per session, including stopped and infrastructure-failed runs. Do not treat the Claude status light as that record.
8. Race claims on a deterministic ref. Do not treat a label write as the lock.
9. Keep factory policy files out of the candidate's write set, and keep merge authority on a GitHub ruleset that the coding identity cannot bypass.
