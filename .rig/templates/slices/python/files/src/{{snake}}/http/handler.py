"""The edge: a request becomes a use case call, and a domain error becomes a status. It imports the use cases and the domain, never the store."""
from __future__ import annotations

from urllib.parse import unquote

from {{snake}}.domain.{{snake}} import {{Name}}Error

STATUS = {"not-found": 404}


def make_handler(service):
    def handle(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        body = body or {}
        try:
            if method == "POST" and path == "/{{name}}s":
                return 201, service.add(body.get("id"), body.get("name"))
            if method == "GET" and path.startswith("/{{name}}s/"):
                return 200, service.get(unquote(path[len("/{{name}}s/"):]))
            return 404, {"error": "not found"}
        except {{Name}}Error as err:
            return STATUS.get(err.code, 400), {"error": str(err), "code": err.code}

    return handle
