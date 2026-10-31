"""A store the use cases can be given. Swap it for a database without touching the domain or the use cases."""


class MemoryStore:
    def __init__(self) -> None:
        self._items: dict = {}

    def save(self, item: dict) -> None:
        self._items[item["id"]] = item

    def get(self, item_id: str):
        return self._items.get(item_id)
