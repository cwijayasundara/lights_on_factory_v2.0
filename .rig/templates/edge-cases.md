# Edge-case checklist

The architect walks every intent through these four items at chart time, so the person who owns the PRD settles them once,
in the chart's one question batch, and `/rig:start` finds them in the intent. The three bugs of the shop cart report
(lost updates under concurrent commands, a symlinked data file replaced, `--name --json` taking `--json` as the name) were
all items below that nobody asked at chart.

An item applies only when the intent has that surface (it writes a shared file, takes a path, parses options, can fail). Where
it does and the PRD is silent, write the default as a behaviour under `## Behaviours` or `### Failure behaviour`, cite the
FR-n it refines, and end the line with `(default at chart)`. Do not write the default, and return a question, when the
default needs a mechanism the PRD and the ADRs do not name (a lock, a queue, a new exit code) or when the PRD states the
opposite (for example "last writer wins").

| Item | Default when the PRD is silent |
|---|---|
| Concurrent commands | Two commands at the same moment lose no write and never hand out the same id. The mechanism is the architect's, named in an ADR. |
| File and path edge cases | A data file that is a symlink is written through the link and stays a symlink; a missing file is created; an unreadable or corrupt file exits non-zero with the path in the message and changes nothing. |
| Option parsing | An option that takes a value, given another option (`--name --json`) or nothing, fails with a message naming the option; it never takes the other option as its value. A flag no command knows fails the same way. |
| Failure exit codes | Success is 0, a usage error is 2, any other failure is 1 unless the PRD lists codes; each failure writes one line to stderr and nothing to stdout. |

A question has the recommended option first: the default above, or the PRD's own wording when it states the opposite. At most 8
such questions per sprint, in batches of at most 4; an item past the cap goes under the intent's `## Open questions`, which
makes the intent unsettled so `/rig:start` asks it.
