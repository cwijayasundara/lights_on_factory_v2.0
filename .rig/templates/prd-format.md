---
product: <name>
sprint: <N>
engineers: 1
owner: <product owner>
---
# PRD: <product>, sprint <N>

<!-- Written for a coding agent. Prose is welcome in Context, Goals and Scenarios; every rule goes in Functional requirements,
Data rules or Non-functional requirements as its own numbered line with exact values, because rig traces those lines, one by
one, to intents, tests and the code review, and nothing else. A PRD in another shape is converted into this one by /rig:chart,
and a person approves the conversion. Ids are stable across sprints. `node <rig>/scripts/sdlc.ts prd check <N>` checks it. -->

## Context and problem

<!-- Who hurts today, how, and the evidence. -->

## Goals and success metrics

<!-- Goal, metric, baseline, target, how measured. -->

## Non-goals

<!-- What is not built, one bullet each: "No user accounts or login." -->

## Users and scenarios

<!-- Walk-throughs with real values, e.g. "S1. Adds "Coffee beans" x2 at 8.50. The cart shows one line, total 17.00." -->

## Functional requirements

### FR-1: <name>

Need: <one sentence: what the user needs>
Priority: must

- AC-1.1: WHEN <trigger> THE SYSTEM SHALL <response with exact values>

<!-- One `### FR-n` per capability. Only `Need:`, `Priority:` (must | should | could), `Depends on:` and criteria go under it.
A criterion is one line, `- AC-n.m: WHEN <trigger> THE SYSTEM SHALL <response>` or `- AC-n.m: Given <state>, when <action>,
then <result>`, with exact numbers, statuses, error names and messages. Errors are criteria of their FR. Worked example:

### FR-2: Add the same item twice

Need: adding a sku already in the cart grows that line instead of adding a second one.
Priority: must

- AC-2.1: Given a cart holding coffee with quantity 2, when add("coffee", "Coffee beans", 3) is called, then the cart holds one coffee line with quantity 5
- AC-2.2: WHEN add is called with a quantity that is not an integer or is below 1 THE SYSTEM SHALL raise ValidationError and leave the cart unchanged
-->

## Data rules

- DR-1: <an invariant on stored data, e.g. "Each item id is an integer starting at 1.">

<!-- Rules every stored record keeps, one line each: ids, uniqueness, ranges, formats, ordering, what is never reused.
`none` when there are none. -->

## Non-functional requirements

| ID | Category | Requirement | Target | Verified by |
|---|---|---|---|---|
| NFR-1 | <category> | <what> | <number and unit, e.g. under 200 ms> | <test level> |

## Examples

<!-- Sample inputs, outputs and error shapes in fenced blocks, each captioned with the criterion it shows, e.g.
"`cart list` output (AC-6.1):" followed by the exact text. One real example beats a paragraph. -->

## Boundaries

- Always: <e.g. run the tests before every commit>
- Ask first: <e.g. adding a dependency or changing the file format>
- Never: <e.g. use floats for money>

## Integrations and constraints

<!-- The stack with exact versions (e.g. Python 3.11, pytest 8), external systems, hosting, regulation, deadlines. -->

## Decisions

<!-- - YYYY-MM-DD: <decision> — <why>. Answers given at chart are added here or as criteria, marked "(answered at chart)". -->

## Open questions

none
