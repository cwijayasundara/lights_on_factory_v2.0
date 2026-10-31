<!-- rig:begin (written by /rig-init; edit outside these markers, a re-run replaces only this block) -->
## Development with rig

This repo uses **rig**, a thin SDLC harness for Claude Code. Each idea (`/rig-start <idea>`) or charted intent becomes a gated, tested, reviewed PR, and an incident comes back as a new idea. Every step is checked by deterministic scripts, locally and in CI, and every approval is a person's.

### Architecture

```
 YOU        /rig-start  /rig-approve                               intent, approval
 SKILLS     start · plan · build · test · pr · chart · and more    the steps
 AGENTS     architect·sonnet  evaluator·opus (reviews the chart)  model by role
 HOOKS      session-start · prompt-submit · post-edit · stop     guardrails, zero tokens
            git: pre-commit · pre-push                           any editor or agent
 SCRIPTS    .rig/bin/sdlc.ts → check · sensors · verify · …    the deterministic brain
 EVIDENCE   .rig/product/  .rig/changes/<slug>/                 committed; read by CI
```

- **Lifecycle of one change:** intent and spec (behaviours B1, B2, …) → plan → a person approves (`approval.json`) → build test-first → test (`verify.json`: every commit and ci sensor, the contracts, a test per behaviour) → PR → review. The type (feature, bugfix, refactor, chore) decides only how new tests are proved against the base.
- **Human gate:** a person approves each change's spec and plan with `/rig-approve <slug>`; approval freezes the contract files. A model can never approve.
- **Order:** an intent starts only once the intents in its `depends:` have shipped.
- **Deterministic checks decide:** the sensors in `.rig/sensors.json` (each with a command or a built-in, a cadence and one guide sentence) must pass; failures that already existed are recorded as `knownRed` so rig never blocks on debt it did not create.
- **State lives in files:** `.rig/sensors.json` (config), `.rig/product/brief.md` (the product brief), `.rig/product/sprints/sprint-<N>/intents/` (charted intents), `.rig/maintain/proposals/` (intents proposed by Maintain), `.rig/changes/<slug>/` (intent, spec, plan, `approval.json`, `evidence/`, `verify.json`, `pr.md`), `.rig/bin/` (vendored harness), `.claude/` (hooks and settings), `CLAUDE.md` (project context for Claude).
- **Local equals CI:** `rig-check` in CI runs the same checks as the git hooks.

### Layout: what rig put in this repo

Claude Code only discovers skills, agents and hooks under `.claude/`; everything else is rig's own state under `.rig/`.

| Path | What it is | Who changes it |
|---|---|---|
| `.claude/skills/rig-*/` | The slash commands (`/rig-start`, `/rig-plan`, …) | `vendor --standalone` (upgrade) |
| `.claude/agents/rig-*.md` | The architect and evaluator subagents | `vendor --standalone` |
| `.claude/settings.json` | Hook wiring and permission rules (ask/deny protect evidence) | `init --full`, a person |
| `.rig/bin/` | The vendored checker (`sdlc.ts` and its modules, `VERSION`) | `vendor --standalone` |
| `.rig/mod/` | The journey dashboard: a band above the prompt with the sprint rail, the change rail, the next command and spend (a local plugin named `rig`) | `vendor --standalone` |
| `.rig/githooks/` | `pre-commit` and `pre-push`, run by git via `core.hooksPath` | `hooks install` |
| `.rig/guides/` | Engineering, testing and contract guides injected at edit time | a person (asks first) |
| `.rig/templates/` | Formats for intents, specs, test plans and the README block | `vendor --standalone` |
| `.rig/sensors.json` | The sensor registry: commands, cadences, `knownRed` | a person (asks first) |
| `.rig/product/` | The product brief, architecture and ADRs, and one folder per sprint (`sprints/sprint-N/`: PRD, intents, test plan, review, approval) | a person, `/rig-chart` |
| `.rig/changes/<slug>/` | One folder per change: spec, plan, approval, evidence, `verify.json`, `pr.md` | the build steps |
| `.rig/.gate` | Local gate state, never committed | rig |
| `.rig/.gitignore` | What under `.rig/` stays local; committed | rig |

### User guide

| You want to | Run |
|---|---|
| Plan a whole sprint from a PRD (greenfield or brownfield) | write `docs/prd/sprint-0/prd.md` (one folder per sprint), then `/rig-chart 0 @docs/prd/sprint-0/prd.md` (gap questions, intents, architecture, test plan, review) |
| Start a change | `/rig-start "<what you want>"` |
| Continue a change | `/rig-start <slug>` (it picks up at the first missing step) |
| Approve a change | `/rig-approve <slug>`; only a person can |
| Waive a failing sensor with a reason | `/rig-waive <sensor> <file> <reason>` (a file or `*`, for the active change; only a person can) |
| See where a change stands | `node .rig/bin/sdlc.ts status` |

**New repo with a PRD?** Start the outer loop, not `/rig-start`. Put the product brief in `.rig/product/brief.md` and the PRD in `docs/prd/sprint-0/prd.md`, one folder per sprint (`docs/prd/prd-template.md` is the format; others in `.rig/templates/`; give every requirement an id like `FR-1`). Then `/rig-chart 0 @docs/prd/sprint-0/prd.md` (gap questions, intents, architecture, ADRs, test plan and cases, an Opus review), review the branch, `/rig-approve chart-0` (a person), merge, and build each intent with `/rig-start .rig/product/sprints/sprint-<N>/intents/<slug>.md`. `node .rig/bin/sdlc.ts ready` lists what can start.

Typical flow for one change (or start from a charted intent: `/rig-start .rig/product/sprints/sprint-<N>/intents/<slug>.md`; a team charts a sprint first with `/rig-chart <N>`, and a person approves it with `/rig-approve chart-<N>`):

1. `/rig-start "add user signup"`, then `/rig-plan`. Read `spec.md` and `plan.md` in `.rig/changes/<slug>/`.
2. Approve with `/rig-approve <slug>`.
3. `/rig-build <slug>` builds, tests and opens the PR. Review it, then merge as usual.
4. Commit `.rig/`, `.claude/` and `CLAUDE.md`; they are the evidence CI reads.

Good to know:

- A bug starts with a failing test; a refactor starts with characterization tests; a one-liner is a chore with almost no ceremony.
- Run the project's checks by hand with the commands in `CLAUDE.md`; `.rig/bin/sdlc.ts check` runs the gate.
- A teammate who never opens Claude Code runs `node .rig/bin/sdlc.ts hooks install` once so the git hooks apply to them.
- To upgrade rig, re-run `vendor --standalone` from a newer plugin checkout. Re-running `/rig-init` only replaces this section.
- **Model versions:** agents name a model by alias (`sonnet`, `opus`), never a version. `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` in `.claude/settings.json` `env` map each alias to a release; change those two lines when a new model ships (unset, the aliases follow the newest). `models.*` in `.rig/sensors.json` name a role's family, so a bump never trips `model-role`.
<!-- rig:end -->
