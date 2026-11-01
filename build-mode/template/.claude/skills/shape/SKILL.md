---
name: shape
description: Turn an idea into an approved spec, glossary, decision records and acceptance examples with the operator, before any build. Invoke it when starting a project or a new feature set, never in an unattended build.
---

# Shape

You and the operator are deciding what to build. Nobody builds yet. Never write code, PLAN.md or tests in this phase. The output is documents the unattended build can trust.

## Grill first

- Ask one question at a time. Wait for the answer before the next one.
- With each question, give your recommended answer and why, so the operator can say "yes" and move on.
- If the repository can answer a question (existing code, docs, commands), read it instead of asking.
- Walk the decisions in dependency order: who uses it and how, then inputs and outputs, then edge cases and errors, then constraints, then what is out of scope.
- Stop grilling when no open decision remains that a builder would have to guess. Do not keep asking to look thorough.

| The excuse | The answer |
| --- | --- |
| "The idea is clear enough, skip the questions" | The builder cannot ask. Every guess it makes is a defect you chose not to prevent. |
| "Ask all the questions at once" | The answers depend on each other. One at a time keeps each decision small. |
| "Put the design in the spec too" | The spec says what and why. How is the builder's job and goes in DECISIONS.md. |
| "The examples can come later" | The acceptance suite is written from them. No examples, no independent check. |

## Write the documents

1. **SPEC.md** with these sections: Goal, Non-goals, Users and interfaces, Behaviour, Demo, Constraints, Acceptance examples.
   - Demo is one command and its exact expected output. The build's last task runs it.
   - **Acceptance examples** are concrete: a given input or state, the exact expected output or exit code. Cover the normal path, every error case and every boundary you decided on. If an expected result needs judgment to check, rewrite it until it does not.
2. **GLOSSARY.md**: one line per term, `**Term**: meaning`, using the words the spec uses. Terms the spec and code must share, nothing else.
3. **docs/adr/NNNN-title.md**, only for a decision that was contested or would be re-litigated. Sections: Context, Decision, Consequences. Number from 0001.

Show the operator each document and revise it. Do not call anything approved until they say so.

## Hand off

When the operator approves, commit the documents with `docs: approved spec`. Then tell them the next command, from the factory repository:

```
node scripts/install-build-mode.ts <this repository> --demo "<the Demo command>" --acceptance
```

`--acceptance` starts a separate session that reads only the spec and writes the acceptance suite into `acceptance/`. The builder can run that suite but never edit it. The build then starts with `.factory/start-build.sh`.
