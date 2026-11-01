# mini-agent-kit

Status: approved spec. Built unattended by the lights-on factory's build mode.

## Purpose

An offline toolkit for building tool-using agents. You register plain Python functions as tools, then run an agent loop against a model. The kit ships a scripted fake model, so every run is deterministic, needs no network or API keys, and can be tested end to end. A real provider can be added later by implementing one small protocol.

## Stack

- Python 3.12, managed with uv. Package `mini_agent_kit` under `src/mini_agent_kit/`. Console script `mini-agent`.
- Runtime dependencies: the standard library only.
- Dev dependencies: pytest, pytest-cov, ruff, mypy. The code passes `mypy --strict src`.

## Tool registry

- Register a tool with the `@tool` decorator on a registry, or with `registry.register(fn)`. Both return the original function unchanged.
- The tool's name is the function name. Its description is the docstring's first paragraph. A tool without a docstring is rejected at registration with `ValueError`.
- The input schema is a JSON Schema object derived from the type hints. Supported parameter types: `str`, `int`, `float`, `bool`, `list[T]` of those, and `Literal[...]` of strings or ints. A parameter with a default is optional; one without is required. Any other annotation is rejected at registration with `TypeError` naming the parameter.
- `registry.schemas()` returns every tool's `{"name", "description", "input_schema"}`, sorted by name.
- `registry.call(name, arguments)` validates the arguments against the schema, then calls the function. It never raises into the caller. It returns either the result, or a `ToolError` with a message:
  - unknown tool: `unknown tool: <name>`
  - missing required argument: `missing argument: <field>`
  - unexpected argument: `unexpected argument: <field>`
  - wrong type: `<field>: expected <type>`
  - the tool itself raised: `<name> failed: <exception message>`
- A `bool` is not accepted where an `int` or `float` is expected.

## Model protocol

```python
class Model(Protocol):
    def complete(self, messages: list[Message], tools: list[ToolSchema]) -> ModelReply: ...
```

- A `ModelReply` is exactly one of: a final text answer, or a non-empty list of tool calls. A tool call has `id: str`, `name: str` and `arguments: dict[str, object]`.
- `Message` has a `role` (`user`, `assistant` or `tool`) and content. Assistant messages may carry tool calls. Tool messages carry the `tool_call_id` they answer and the result as text: a `ToolError` becomes `error: <message>`.

## Scripted fake model

- `ScriptedModel.from_file(path)` loads a JSON script. `ScriptedModel(turns)` takes the same data in memory.
- A script is `{"turns": [...]}`. Each turn is either `{"final": "<text>"}` or `{"tool_calls": [{"id", "name", "arguments"}]}`. A turn may also carry `"expect": {"<tool_call_id>": "<exact tool message text>"}`.
- Each `complete` call returns the next turn. When a turn has `expect`, the model checks the tool messages it received for those ids, and raises `ScriptMismatch` naming the id, the expected text and the actual text when they differ.
- Calling `complete` after the last turn raises `ScriptExhausted`.
- A malformed script (a turn with both or neither of `final` and `tool_calls`, a tool call missing a field) is rejected when loaded, with `ValueError` naming the turn index.

## Agent loop

- `run(question: str, model: Model, registry: Registry, max_steps: int = 8) -> RunResult`.
- The loop sends the conversation and the tool schemas to the model. When the reply has tool calls, it runs them in order through the registry, appends the assistant message and one tool message per call, and asks again. When the reply is final, it stops.
- `RunResult` has `answer: str | None`, `steps: list[Step]` and `stop_reason`, one of `final`, `max_steps` or `error`.
- `max_steps` counts model calls. When it is reached without a final answer, the result has `stop_reason="max_steps"` and `answer=None`.
- An exception from the model (including `ScriptMismatch` and `ScriptExhausted`) ends the run with `stop_reason="error"`. The error message is recorded on the last step. `run` does not raise.

## Run trace

- Each `Step` records the messages sent, the model's reply, the tool results (name, arguments, result text) and the duration in milliseconds.
- `RunResult.to_json() -> str` and `RunResult.from_json(text) -> RunResult` round-trip exactly, apart from durations, which are kept as numbers.

## Built-in tools and demo

- Three toy tools live in `mini_agent_kit.toys`:
  - `calculator(expression: str) -> str`: evaluates `+ - * /`, parentheses and integer or decimal numbers by parsing, never with `eval`. Integer results print without a decimal point. Division by zero is an error.
  - `word_count(text: str) -> int`: the number of whitespace-separated words.
  - `clock(timezone: str = "UTC") -> str`: the current time in ISO 8601, for an IANA timezone name. An unknown zone is an error. Tests inject the time.
- `mini-agent demo` runs the bundled script `mini_agent_kit/scripts/demo.json` against the question `What is 17 * 23, and how many words are in 'the quick brown fox'?`. It uses the calculator and word_count tools and prints exactly:

```
question: What is 17 * 23, and how many words are in 'the quick brown fox'?
step 1: calculator({"expression": "17 * 23"}) -> 391
step 2: word_count({"text": "the quick brown fox"}) -> 4
answer: 391; 4 words
```

  It exits 0. The demo script uses `expect` on both tool results, so a wrong tool result fails the demo.
- `mini-agent run --script <file> [--trace <out.json>] "<question>"` runs any script with the toy tools, prints the same step format, writes the trace when asked, and exits 0 on `final`, 1 on `max_steps`, and 2 on `error`.

## Out of scope

Real model providers, streaming, async, parallel tool calls, memory between runs, and any network access.

## Done means

Every build-mode gate passes, `uv run mini-agent demo` prints exactly the four lines above, and the README explains in a few lines how to register a tool and run the demo.
