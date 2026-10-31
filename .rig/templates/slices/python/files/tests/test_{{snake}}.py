import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from {{snake}}.app.service import {{Name}}Service  # noqa: E402
from {{snake}}.http.handler import make_handler  # noqa: E402
from {{snake}}.infra.memory_store import MemoryStore  # noqa: E402


def handle():
    return make_handler({{Name}}Service(MemoryStore()))


class {{Name}}Test(unittest.TestCase):
    def test_adds_one_and_reads_it_back(self):
        h = handle()
        self.assertEqual(h("POST", "/{{name}}s", {"id": "a1", "name": " First "})[0], 201)
        self.assertEqual(h("GET", "/{{name}}s/a1")[1], {"id": "a1", "name": "First"})

    def test_a_bad_input_is_a_400_that_carries_a_code(self):
        status, body = handle()("POST", "/{{name}}s", {"id": "", "name": "x"})
        self.assertEqual((status, body["code"]), (400, "invalid-id"))

    def test_an_unknown_id_is_a_404(self):
        self.assertEqual(handle()("GET", "/{{name}}s/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
