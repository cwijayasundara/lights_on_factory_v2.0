"""The {{name}} rules as plain functions: no I/O, no framework, and nothing imported from another layer."""


class {{Name}}Error(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def create_{{snake}}(item_id: str, name: str) -> dict:
    if not isinstance(item_id, str) or not item_id.strip():
        raise {{Name}}Error("invalid-id", "id is required")
    if not isinstance(name, str) or not name.strip():
        raise {{Name}}Error("invalid-name", "name is required")
    return {"id": item_id.strip(), "name": name.strip()}
