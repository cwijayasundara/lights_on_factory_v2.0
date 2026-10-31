---
sprint: <N>
updated: <YYYY-MM-DD>
---
# Sprint <N> implementation plan

<!-- The architect writes this at chart time, beside the intents. A team lead reads it to hand intents to engineers; each engineer reads their
intents' sections to build them, and /rig:plan starts from that section. Plans hold files, interfaces and tests, never code bodies. The build
order itself (waves, graphs, who owns what) is plan.md, generated from the intents: do not repeat it here. At most 40 lines per intent. -->

**Goal:** <!-- what the sprint ships, in one sentence, from the PRD -->

**Architecture:** <!-- two or three sentences: the parts this sprint adds and how they connect; point to architecture.md, do not retype it -->

**Tech stack:** <!-- language, framework, the libraries in play, test runner -->

**Design:** <!-- the sprint design doc's repo-relative path -->

## Global constraints

<!-- Rules every intent obeys: layer boundaries, error and logging conventions, units and formats the PRD fixes, NFR targets. One bullet each. -->

## Review focus

<!-- What a reviewer must check across the sprint: the risky edges, the behaviours that fail quietly when wrong. One bullet each. -->

## Allocation

<!-- One row per lane, for the PRD's `engineers:` count (one lane per engineer). Intents: this lane's intents in build order, separated by →;
every intent of the sprint sits in exactly one lane, after its dependencies in that lane. Suits: senior when the lane holds an interface others
build on, a contract, concurrency, security or a risky migration; any otherwise. Why: the reason in a few words. A lane waiting on another
lane's intent says so in Why. The person fills `owner:` in each intent; this table only suggests. -->

| Lane | Intents | Days | Suits | Why |
|---|---|---|---|---|

## Intents

<!-- One `### <slug>` section per intent, in wave order (plan.md's waves), each:

### <slug>

Depends on: <slugs or none> · Estimate: <days> · Suits: senior | any

Files: <the files it creates or changes, as in architecture.md's Code structure>; tests: <the test files>.

Interfaces: <signatures and data shapes it adds or changes, named as in its ## Design; none for a pure internal change>

- [ ] B1: write the failing test for <behaviour> in <test file>; run it and see it fail
- [ ] B1: implement <what> in <file>; the test passes
- [ ] B2, B3: ...
- [ ] run <the verification command>

Every B-number of the intent appears in at least one task; tests come before the code they prove. -->
