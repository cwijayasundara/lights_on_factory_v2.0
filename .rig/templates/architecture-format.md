---
sprint: <N>
updated: <YYYY-MM-DD>
design: <path or none>
---
# Architecture

<!-- Living document, at most 250 lines, one for the whole product. The architect updates it for each sprint's PRD and records in Sprint history what that sprint added; per-sprint detail lives in .rig/product/sprints/sprint-N/. Name the real language, framework and libraries from the PRD; never write "a web framework". -->

## Context

<!-- The product, its users and the systems around it, in a few lines. -->

## Technology stack

<!-- One row per concern, every Choice taken from the PRD's constraints or an answer given at chart, else decided in an ADR (cite it). Language and Framework rows are required: write "none (standard library)" when there is no framework. Typical rows: Language, Framework, Libraries, Data store, Messaging, Hosting, Packaging, Test, Lint and types. -->

| Concern | Choice | Version | Source |
|---|---|---|---|
| Language | | | |
| Framework | | | |
| Test | | | |

## Architecture diagram

<!-- A mermaid diagram (```mermaid fenced block) of the containers or modules, the external systems and which way dependencies point, then the same picture as an ASCII diagram in a ```text block (boxes and arrows, for terminals and plain-text readers). Name the real modules, as in Code structure; the two diagrams never disagree. -->

## Code structure

<!-- A fenced tree of the source layout this architecture implies, in the stack's own conventions (for example src/<package>/ and tests/ for Python, src/main/java/... for Java, src/app/ for Angular). One short comment per directory or file, and the sprint that adds it: `models.py   # cart rules (sprint 1)`. Files that exist are shown as built; files to come are marked (planned). -->

## Containers and modules

<!-- The parts, where they run, which way dependencies point. Table: Module | Responsibility | Must not. -->

## Key flows

<!-- A mermaid sequenceDiagram for each main use case or request path, naming the modules from the diagram, each followed by the same flow as an ASCII diagram in a ```text block (numbered steps with arrows between the modules). At least one. -->

## Data

## Integrations

<!-- Each interface and the contract file that fixes it. -->

## Access

<!-- Optional: delete this section when the product has no users or roles. One row per action. Allowed: roles, comma-separated, or nobody (refused to everyone). Interfaces: where the action can be called (web, api, cli); each is tested on its own, because shared backend code proves nothing about another interface. Intent: the intent that builds the action. -->

| Action | Allowed | Interfaces | Intent |
|---|---|---|---|

## Quality tactics

<!-- One row for every NFR in the PRD: its target, the tactic that meets it, the module or file that carries the tactic, and the test or sensor that proves it. -->

| NFR | Target | Tactic | Where | Verified by |
|---|---|---|---|---|

## Deployment

## Sprint history

<!-- One row per charted sprint: what it added to the architecture, its intents and its ADRs. The newest row last. -->

| Sprint | Adds | Intents | ADRs |
|---|---|---|---|

## Decisions

<!-- Index of .rig/product/adr/NNNN-<kebab>.md: status proposed | accepted | superseded-by NNNN, and the sprint that took it. An accepted ADR is never edited. -->

## Concerns

<!-- A gap between the intended and the as-built design, one bullet each with an owner. none when resolved. -->
none

## Open questions

none
