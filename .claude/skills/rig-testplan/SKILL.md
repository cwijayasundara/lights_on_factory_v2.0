---
name: rig:testplan
description: Write a sprint's test plan, test cases and test data from its PRD and intents, each case traced to a requirement. For the QA lead.
argument-hint: '<sprint number>'
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts *), Bash(git checkout*), Bash(git add*), Bash(git commit*), Bash(git status*), Bash(git diff*), Read, Grep, Glob, Write, Edit, Agent
---
# Test plan for a sprint

`/rig-chart <N>` already runs this as its step 4. Use this skill alone to redo the plan after the PRD or an intent changed.

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`. Run each command as its own Bash call.

1. **Which sprint.** `N` is `$ARGUMENTS`. Run `S chart check <N>`. It needs the PRD and the intents from `/rig-chart <N>`; without them, stop and say so.
2. **QA.** Launch one `general-purpose` agent in the foreground with model `sonnet` and a brief of at most 40 lines:
   - read the PRD, every `.rig/product/sprints/sprint-<N>/intents/*.md`, `.rig/product/architecture.md`, the sprint's design doc, the `<date>-sprint-<N>-design.md` in the directory of the `design:` path in `.rig/product/architecture.md` (`design:` names only the newest sprint's doc; `none`, an unset line or a `<...>` placeholder means there is none) and `.rig/templates/testplan-format.md`;
   - write `.rig/product/sprints/sprint-<N>/testplan/plan.md`, `cases.md` and `data/`;
   - every requirement gets at least one case; every case cites its requirement ids, an intent slug and one of its B-numbers; a contract-level case for a `kind: boundary` intent uses that intent's example files;
   - for every `## Access` row in `architecture.md` whose intent is this sprint's: one allowed and one refused case per interface (refused only, for `nobody`), with the Access column filled as `<action>: allowed <interface>` or `<action>: refused <interface>`;
   - test data is synthetic, never real personal data; a case's Data is a path under `.rig/product/sprints/sprint-<N>/testplan/` such as `data/cart.json`, or `-`.
3. **Check.** `S chart check <N> --cases --json`. Make at most one fix round for the findings, then check again. Then launch `rig-evaluator` in test plan mode ("review the test plan for sprint <N>"; Opus by its front matter; never pass a model override) and write its reply to `.rig/product/sprints/sprint-<N>/testplan-review.md`. It reviews the test plan against the PRD and the intents; fix its findings once.
4. **Commit** on branch `rig/chart-<N>` (`git checkout rig/chart-<N>`, or `git checkout -b` when it does not exist): `git add .rig/product`, `git commit -m "docs: test plan for sprint <N>"`.
5. End with the case count per level, any finding still blocking, and `Next: review the branch, then a person runs /rig-approve chart-<N>`.
