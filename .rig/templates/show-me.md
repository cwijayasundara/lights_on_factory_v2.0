Views for plans and PR outlines. Use the fewest that make the point; put each next to the one line it supports.

- A change to an existing shape: a `diff` block (`+` added or changed, `-` removed, a space for context).
- Who owns what: a shallow file tree with tree glyphs (`├──`, `└──`) and a few words of responsibility per line; leave out unchanged paths.
- Runtime flow: a call tree, one call per indented line.
- Logic: pseudocode.
- A contract or schema: the changed fields only, or the whole shape when most of it is new.
- A shape that is mostly new: the complete block, not a diff.

```diff
 src/
 ├── export/
+│   └── csv.ts       # builds the CSV rows
 └── report.ts
```
