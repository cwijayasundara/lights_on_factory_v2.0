# How a feature is laid out here

A feature lives in `src/<feature>/` as four directories. Dependencies point inward and the layers are enforced (`architecture.md ## Layers`):

- `domain/`: the rules, as plain functions and error classes. No I/O, no framework, no imports from another layer.
- `app/`: the use cases. They import the domain and are handed a store; they never import `infra/` or `http/`.
- `infra/`: stores and clients behind a small interface the use cases are given. They import the domain at most.
- `http/`: the edge. Turns a request into a use case call and a domain error into a status. Imports `app/` and `domain/`, never `infra/`.

Conventions the exemplar shows:

- A domain error carries a stable `code`; the edge maps the code to a status, so no layer below it knows HTTP.
- Inputs are validated in the domain, once, and a bad input is a 400 with `{ error, code }`.
- Tests sit in `test/<feature>.test.js` and drive the handler through a real in-memory store, not mocks.
- Wire things at the edge or in a composition file: `make<Feature>Handler(make<Feature>Service({ store: makeMemoryStore() }))`.

Start a new feature with `node .rig/bin/sdlc.ts slice scaffold <name>` (it never overwrites a file). When this repo's own layout differs, follow the repo and say so.

The exemplar is ES modules: package.json needs `"type": "module"` and Node 20.19 or newer.
