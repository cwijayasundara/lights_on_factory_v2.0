# Harness options for Lights On Factory

Research date: 2026-10-31. Method: primary documentation and public source inspection; no comparative execution benchmark was run.

## Recommendation after the runtime clarification

Use native Claude Code cloud as requested, retain Rig's useful SDLC policy, and adapt Rig's loading and approval flow. Use a small GitHub Actions layer for deterministic coordination and CI. Do not replace Claude Code with Pi or treat gh-aw as a drop-in Rig replacement.

The earlier recommendation of gh-aw addressed an Actions-hosted coding runtime. That remains a valid alternative hosting architecture, but does not satisfy the clarified requirement to execute through Claude Code's native cloud-session service. The distinction changes authentication, billing, plugin loading and automation controls.

## Separate the layers

| Product | What it is | Relationship to this request |
| --- | --- | --- |
| Claude Code | Coding-agent runtime with tools, sessions, hooks and skills | Keep; explicitly requested |
| Claude Code cloud/on the web | Hosted execution surface for Claude Code | Use as coding compute |
| Rig | SDLC plugin/behavioral layer around Claude Code | Adapt, rather than presume cloud portability |
| Pi | Alternative minimal coding-agent runtime | Replaces the runtime; not needed for this factory |
| gh-aw | Compiler/runtime integration for agent workflows on GitHub Actions | Alternative orchestration/execution substrate; can run Claude Code on a runner |
| GSD Core / Superpowers / Matt's skills / Spec Kit | Planning, context and development process toolkits | Potential sources of selected policy, not cloud hosting |
| OpenHands SDK | Programmable coding-agent foundation with workspace/server abstractions | Broader alternative platform, more adoption scope |

## Native Claude cloud: implications that matter for Rig

Cloud sessions execute on hosted compute and use the user's Claude plan allowance. A local CLI session controlled remotely still runs locally; it is not the desired hosting. Native launch and an Actions `claude -p` subprocess are separate paths. [Cloud documentation](https://code.claude.com/docs/en/claude-code-on-the-web).

Ordinary one-repository cloud sessions can load committed skills and settings hooks. Repository-declared plugins are not automatically installed, and local home configuration does not transfer. Vendor and test the needed Rig scripts/skills/hooks or prove an explicitly supported install method. [Environment documentation](https://code.claude.com/docs/en/cloud-environments).

Projects threads have different configuration semantics: repository settings hooks do not run and repository skills/plugins do not load as ordinary sessions do. Account/project plugin settings may help, but compatibility needs its own proof. Do not choose Projects as an orchestrator before verifying the actual harness behavior. [Projects documentation](https://code.claude.com/docs/en/claude-projects).

Native scheduled tasks/routines provide schedule, GitHub-event and API triggers. Their API is research preview. Trigger acceptance is not task completion, and events/permissions/limits can still require intervention. Routine actions can use the linked user's GitHub identity, so verify how a solo human will approve PRs; a separate bot publisher avoids self-review conflicts. [Scheduled tasks](https://code.claude.com/docs/en/routines).

## Alternatives assessed

### Rig retained and reduced to a cloud profile — preferred

Rig already provides intent/spec/plan artifacts, sensors, verification, architecture work, risk policy and human gate checks. Its build flow requires a per-change approval, so the requested single planning checkpoint needs a real batch-authorization path. CI remains the authority; local flags or approval files cannot establish human intent. [Rig README](https://github.com/cwijayasundara/rig_v1/blob/f33015bf12e711be7441eca45fefb177fd5d81cc/README.md), [approval logic](https://github.com/cwijayasundara/rig_v1/blob/f33015bf12e711be7441eca45fefb177fd5d81cc/scripts/check.ts).

Reduce operational burden by selecting only the skills/checks needed for this workflow, avoiding interactive brainstorm/plan gates after package approval, and reusing native cloud scheduling. More repository checks do not necessarily mean more human supervision; the important question is which checks require a person.

### gh-aw — strong alternative if execution moves to Actions

Defines agent workflows in Markdown/frontmatter, compiles them into Actions, separates controlled writes, and supports a sandbox. Its value is infrastructure already maintained upstream. It does not automatically provide Rig's domain/architecture/approval policy. [Repository](https://github.com/github/gh-aw).

Its native queue includes Git-backed claims and reconciliation; verified PR delivery and product merge remain different events. A factory needs an explicit merge dependency rule. It is unnecessary machinery for the currently selected native Claude-cloud route. [Pinned v1.0.1 queue documentation](https://github.com/github/gh-aw/blob/v1.0.1/docs/src/content/docs/reference/work-queue.md).

A current release existed when researched: [v1.0.1, October 27, 2026](https://github.com/github/gh-aw/releases/tag/v1.0.1). That establishes availability, not proof it is lighter, safer or more capable on this user's tasks. Its Claude engine's API authentication is distinct from native subscription-backed cloud sessions. [Claude engine reference](https://github.github.com/gh-aw/reference/engines/claude/).

### Claude Code Action / Agent SDK — smaller programmable entry points

The official Action supports event-driven automation and configurable tools/structured results. Its base action is explicitly a thin wrapper and does not supply trust boundaries itself. Both still need a factory's authorization/dependency rules. The Agent SDK exposes the Claude Code loop and tools programmatically; it does not imply execution inside native web cloud sessions. [Action](https://github.com/anthropics/claude-code-action), [base action trust model](https://github.com/anthropics/claude-code-action/blob/main/base-action/README.md), [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

### Pi — light runtime, more policy work for this use case

Pi is a minimal extensible coding-agent harness with print/JSON, RPC and TypeScript SDK modes. It deliberately omits built-in plan mode and subagents. That is useful when building your own runtime, but it does not replace Rig's approval and verification layer. Its current canonical repository is [earendil-works/pi](https://github.com/earendil-works/pi), following the former badlogic/pi-mono URL. [Coding agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

### GSD Core / Superpowers / Matt's skills / Spec Kit — process choices

GSD Core organizes discussion, planning, execution, verification and shipping with fresh contexts. The old GSD repository now points to [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core); do not adopt an archived install path. Its phased process still needs adaptation to the user's two checkpoints. [Old-repository notice](https://github.com/gsd-build/get-shit-done).

Superpowers provides strong development discipline through skills, including design, plans, TDD and review. Its human-interactive design flow is not automatically an unattended cloud factory. Reuse selected discipline rather than stacking whole competing lifecycle frameworks. [Superpowers](https://github.com/obra/superpowers).

Matt's skills supply domain modeling, decision planning and implementation discipline. Their public implementation flow is not a complete durable PR/merge controller. [Matt's skills](https://github.com/mattpocock/skills), [implementation documentation](https://github.com/mattpocock/skills/blob/main/docs/engineering/implement.md).

Spec Kit offers structured specifications, plans and extensible processes. It can improve package generation; it does not by itself supply the native Claude-cloud hosting and external enforcement required here. [Spec Kit](https://github.com/github/spec-kit).

### OpenCode / OpenHands — alternatives to the current platform

OpenCode offers an open coding agent, a typed SDK and GitHub integration. It adds provider/runtime choice, but changing agent runtime is not the user's present goal. [SDK](https://opencode.ai/docs/sdk/), [GitHub integration](https://opencode.ai/docs/github/).

OpenHands SDK provides agent/conversation/workspace abstractions and ephemeral remote workspaces; its automation service adds scheduling/webhooks and database-backed operational components. It is relevant for a broader agent platform, rather than a lighter port of Rig to native Claude cloud. [SDK](https://github.com/OpenHands/software-agent-sdk), [automation service](https://github.com/OpenHands/automation).

## What “lighter and more capable” should mean

Do not equate fewer source lines, stars, token usage or benchmark claims with a better factory. Measure matched real tasks with the same model, starting repository and acceptance scenarios:

1. Human minutes and interventions per accepted intent.
2. Fraction of tasks meeting independent acceptance without rescue.
3. Scope/approval violations and escaped defects.
4. Recovery from a failed session or missed trigger.
5. Total paid usage, elapsed time and factory code the user maintains.

Use at least one bounded feature, a regression fix, a multi-intent dependency chain, a deliberately incomplete PRD and an out-of-scope repair. Include real repository sizes and failure paths, not only tiny seeded examples. Current research supports a cloud-portability pilot and policy simplification; it does not establish a universally superior replacement for Rig.
