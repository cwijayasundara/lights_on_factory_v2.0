---
sprint: <N>
prd: [FR-1]
depends: []
estimate_days: 1
kind: internal
owner:
status: draft
scope: []
touches: []
---
# <Intent title>

<!-- owner: who builds it; left empty by the architect, a person fills it in when allocating the sprint (implementation-plan.md suggests lanes). -->
<!-- One intent is a small piece of work an engineer finishes in 1 to 2 days: code, tests, regression, PR. Bigger? Split it. Every behaviour cites the PRD requirement it serves; an intent no requirement asks for is not written. -->

## Intent

<!-- Why, who has the problem, what done looks like. At most 15 lines. -->

## Non-goals

<!-- Phrase each as a prohibition, for example: "Do not add operations not listed under Interfaces." -->

## Design

<!-- Only the parts this intent adds or changes, named as in architecture.md, one row each:
| Part | Responsibility | Must not |
|---|---|---|
| StockController | maps HTTP to the stock service | call the store directly |
-->

## Interfaces

<!-- kind: boundary (adds or changes an HTTP, message or downstream interface): one line each, `Contract: <file>` and `Example: <file>`, with exact statuses, headers and numbers in the contract. kind: internal: write none. -->

## Behaviours

<!-- - B1 (FR-3): one observable behaviour, stated from outside the system. The parentheses cite an FR-n or NFR-n id, then the requirements.md ids the behaviour serves, e.g. (FR-4, AC-4.1) or (FR-4, DR-2), keeping every number, limit and "never" of those rows; an acceptance-criterion id may follow it (FR-3, AC-3.1) but never stands alone. -->

### Failure behaviour

<!-- What happens when a dependency is slow, down or returns garbage, or a caller sends too much: each a B-number with exact statuses, headers and numbers, for example "- B4 (NFR-2): a store call that takes over 2 s (the timeout default) answers 503 with Retry-After: 5". kind: internal with no such case: write none. -->

## Tests required

<!-- Per behaviour: the level (unit, contract, end-to-end) and the file that will hold it. -->

## Open questions

none
