# Product brief

<!-- rig reads this file as .rig/product/brief.md. In a charted repo the architect fills it: Architecture points to architecture.md, and Behaviours, Failure behaviour and Tests required say "see the intents" (B-numbers are per intent). With no chart, write them here: number each behaviour (B-numbers); every one needs a test whose name or comment says its number. -->

## Context and intent

<!-- Who this is for, the problem, and what success looks like. -->

## Non-goals

<!-- Phrase each as a prohibition, for example: "Do not add operations not listed under Interfaces." -->

## Architecture

<!-- Charted: point to architecture.md, do not retype it. No chart: the parts, where they run, and which way dependencies point, then a table: | Part | Responsibility | Must not |. -->

## Constraints

<!-- Language, runtime, data, security and performance limits. -->

## Interfaces

<!-- Each public surface and its contract file, for example api/openapi.yaml with examples. -->

## Behaviours

<!-- Charted: see the intents. No chart: - B<n>: one observable behaviour, stated from outside the system -->

### Failure behaviour

<!-- Charted: see the intents. No chart: resiliency rules, each a B-number with exact statuses and numbers: deferred work, throttling, invalid downstream responses, and the timeout default. -->

## Tests required

<!-- Charted: see the intents. No chart: per behaviour, the level (unit, contract, end-to-end) and the file that will hold it. -->
