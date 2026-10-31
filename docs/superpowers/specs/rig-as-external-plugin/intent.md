---
slug: rig-as-external-plugin
type: feature
---
# Install the cloud profile from a pinned Rig commit instead of a local factory-rig copy

## Intent

Rig is meant to stay a separate AI SDLC harness (repo `rig_v1`) that this factory and target repos consume as a plugin.
Today the factory keeps a 31 MB copy of Rig in `factory-rig/`, and the design/plan docs say factory Rig improvements are
made in that copy. That turns Rig into a fork that drifts from `rig_v1`.

Cloud sessions still cannot install plugins, so a target repo needs the `vendor --standalone` output committed. That output
is a build artifact; it does not need Rig's source living in this repo.

Done looks like: `factory-rig/` is gone; `cloud/rig-profile/pin.json` names only repository, commit and version; the
installer fetches that commit into a gitignored `.cache/rig/<commit>` (or reuses a clean local checkout at exactly that
commit via `RIG_SOURCE`) and vendors from it; the docs say factory-driven Rig changes go upstream to `rig_v1` and reach
this repo by bumping the pin. The pin stays at `f33015b` (0.7.0).

## Open questions
none
