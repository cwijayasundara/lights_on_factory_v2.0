---
name: rig:arch
description: Declare the layers of this codebase (which directory may import which) so the layering sensor and the stack's own analyser enforce them. Proposes a `rig-layers` block in architecture.md for a person to approve. Use when a repo has no enforced layers, when a design review finds an import crossing a boundary, or when the person says "stop X importing Y".
argument-hint: '[propose | check]'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts arch propose), Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts arch gen), Read, Grep, Glob, Edit, AskUserQuestion
---
# Layers: $ARGUMENTS

Layers are the dependency direction the team intends. Nothing is enforced until a person approves the block, and you cannot approve it.

1. **Facts.** Run `sdlc.ts arch propose`. It lists the source directories and every import already between them, as a draft `rig-layers` block in which all observed imports are allowed. The draft records what the code does today, not what it should do.
2. **Judge each edge.** For every `allow A -> B` line decide with the person whether A importing B is intended. Read `.rig/product/architecture.md` and the code for the reason. Ask with one `AskUserQuestion` batch (at most 4 questions) for the edges you cannot judge; never keep an edge only because the code has it. Remove the mistakes. Add `forbid <layer> -> <package>` for a framework the layer must not touch, and `example <layer> <path>` pointing at one file that shows the right way, so the violation message can name it.
3. **Write it.** Put the block under `## Layers` in `.rig/product/architecture.md` (add the heading if it is missing), in a fenced block tagged `rig-layers`. Format: `layer <name> <glob>`, `allow A -> B, C`, `forbid A -> x, y`, `example <layer> <path>`. A layer with no `allow` line may import no other layer. A layer name's last literal directory is its token and must be at least 3 characters and unique.
4. **Validate.** Run `sdlc.ts arch gen`. Fix every `[layers]` line it prints until it lists the derived rules.
5. **Hand over.** Tell the person to review the block and run `! SDLC_HUMAN=1 node .rig/bin/sdlc.ts arch approve` (the path of the script you ran, if the harness is not vendored). Approval writes the generated analyser config under `.rig/gen/` and baselines the violations that exist today, so only new ones block. Editing the block later never loosens an approved rule; it starts a new proposal.

With `check`, run `sdlc.ts arch gen` and report the state: not configured, proposed, approved, or the block differs from the approval.

End with: `Next: review and approve the layers (you), then /rig-start for the next change`.
