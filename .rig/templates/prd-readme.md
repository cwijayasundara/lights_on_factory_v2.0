# PRDs

One folder per sprint: `sprint-<n>/prd.md`, with anything the PRD refers to (mockups, sample payloads, a PDF original) beside it.

```text
docs/prd/
  sprint-0/prd.md
  sprint-1/prd.md
  sprint-1/checkout-mockup.png
```

Any format works. `prd-template.md` here is the format rig converts to: every rule a numbered line (`FR-1`, `AC-1.1`, `DR-1`, `NFR-1`).
Then run `/rig:chart <n> @docs/prd/sprint-<n>/prd.md`: it copies the folder into `.rig/product/sprints/sprint-<n>/`, converts the PRD
when it is not in the template, and a person approves the conversion. Edit the PRD here, never the copy under `.rig/`.
