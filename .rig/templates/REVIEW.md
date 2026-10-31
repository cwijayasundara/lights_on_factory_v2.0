# REVIEW.md: how changes are reviewed here

Read by the managed GitHub Code Review service, by the clean-context reviewer in `/rig:pr` (`templates/review-brief.md`) and by CI's `ai-review` job. The rules for contracts and non-goals live in `CLAUDE.md` under `## Review`. Edit this file to match your team.

## What failure looks like here
- Replace with the one failure that costs most in this repo, e.g. a rounding bug that silently charges the wrong amount.

## Review passes
1. **Correctness:** behaviour matches the spec's B-numbers; edge cases the intent names are handled.
2. **Security:** input validation, authn/authz on every new endpoint (every action in `.rig/product/architecture.md` `## Access` checked against its row: allowed roles enforced, every other role refused, on each interface), no secrets or PII in logs or errors.
3. **Contracts:** every API, schema or event change is listed in plan.md `## Contracts` and is additive or follows expand–migrate–contract.
4. **Design:** one responsibility per unit; dependencies point inward; no abstraction with a single implementation.
5. **Tests:** every new behaviour is pinned by a test that would fail without the change.

## What counts as Important (critical or high)
- Wrong behaviour, data loss, a security hole, a contract change the plan did not announce, or a missing test for a B-number.

## Nits (medium or lower; never block)
- Naming, comments, small duplication, style a linter does not catch.

## Skip
- Generated files, lockfiles, vendored `.rig/bin/**`, and anything CI's rig-check already enforces.
