import importlib.util
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PATH = REPO_ROOT / "memory_api" / "app.py"

def load_app(name, root, read_only=False):
    os.environ.update({
        "GB_REGISTRY_PATH": str(root / "state" / "registry.sqlite"),
        "GB_DOCS_PATH": str(root / "docs"),
        "GB_OUTPUT_DIR": str(root / "output"),
        "GB_UI_TOKEN": "synthetic-projection-token",
        "GB_UI_SCOPE_TOKENS": "{}",
        "GB_API_READ_ONLY": "1" if read_only else "0",
    })
    spec = importlib.util.spec_from_file_location(name, APP_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module

class MemoryApiProjectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memory-api-projection-")
        self.root = Path(self.temp.name)
        self.module = load_app(f"memory_api_projection_{id(self)}", self.root)
        from fastapi.testclient import TestClient
        self.client = TestClient(self.module.app)
        self.client.__enter__()
        self.headers = {"X-GB-Token": "synthetic-projection-token"}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def rows(self, sql, params=()):
        with sqlite3.connect(self.root / "state" / "registry.sqlite") as conn:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def test_create_update_confirm_reject_merge_project_every_surface(self):
        created = self.client.post("/memories", headers=self.headers, json={
            "content": "Synthetic API projection fact alpha", "type": "DECISION",
            "scope": "profile:main", "concept": "synthetic-concept",
            "source_message_id": "source-alpha", "ttl_days": 30, "pinned": True,
        })
        self.assertEqual(created.status_code, 200, created.text)
        memory_id = created.json()["id"]
        current = self.rows("SELECT * FROM memory_current WHERE memory_id=?", (memory_id,))[0]
        legacy = self.rows("SELECT * FROM memories WHERE id=?", (memory_id,))[0]
        metadata = self.rows("SELECT * FROM memory_console_metadata WHERE memory_id=?", (memory_id,))[0]
        for key in ("type", "content", "normalized", "scope", "status", "created_at", "updated_at"):
            self.assertEqual(current[key], legacy[key], key)
        self.assertEqual(metadata["concept"], "synthetic-concept")
        self.assertEqual(metadata["source_message_id"], "source-alpha")
        self.assertEqual(metadata["ttl_days"], 30)
        self.assertEqual(metadata["pinned"], 1)
        self.assertRegex(current["normalized_hash"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(self.rows("SELECT * FROM memory_events WHERE memory_id=?", (memory_id,))), 1)

        updated = self.client.patch(f"/memories/{memory_id}", headers=self.headers, json={
            "content": "Synthetic API projection fact alpha updated",
            "review_version": "rv-api", "review_reason": "synthetic",
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(
            self.rows("SELECT content FROM memory_current WHERE memory_id=?", (memory_id,))[0],
            self.rows("SELECT content FROM memories WHERE id=?", (memory_id,))[0],
        )
        self.assertEqual(self.rows("SELECT review_version, review_reason FROM memory_console_metadata WHERE memory_id=?", (memory_id,))[0], {
            "review_version": "rv-api", "review_reason": "synthetic",
        })

        second = self.client.post("/memories", headers=self.headers, json={
            "content": "Synthetic API projection fact alpha alternate wording", "type": "DECISION",
            "scope": "profile:main", "concept": "synthetic-concept",
        })
        second_id = second.json()["id"]
        self.assertEqual(self.client.post(f"/memories/{memory_id}/confirm", headers=self.headers).status_code, 200)
        self.assertEqual(self.rows("SELECT status, superseded_by FROM memory_current WHERE memory_id=?", (second_id,))[0], {
            "status": "superseded", "superseded_by": memory_id,
        })
        self.assertEqual(self.client.post(f"/memories/{memory_id}/reject", headers=self.headers).status_code, 200)
        for table, key in (("memory_current", "memory_id"), ("memories", "id")):
            statuses = self.rows(f"SELECT status FROM {table} WHERE {key} IN (?,?)", (memory_id, second_id))
            self.assertEqual({row["status"] for row in statuses}, {"rejected"})

        keep = self.client.post("/memories", headers=self.headers, json={"content": "Synthetic merge survivor", "scope": "profile:main"}).json()["id"]
        loser = self.client.post("/memories", headers=self.headers, json={"content": "Synthetic merge duplicate", "scope": "profile:main"}).json()["id"]
        merged = self.client.post("/memories/merge", headers=self.headers, json={"keep_id": keep, "merge_ids": [loser]})
        self.assertEqual(merged.status_code, 200, merged.text)
        for table, key in (("memory_current", "memory_id"), ("memories", "id")):
            self.assertEqual(self.rows(f"SELECT status, superseded_by FROM {table} WHERE {key}=?", (loser,))[0], {
                "status": "superseded", "superseded_by": keep,
            })

    def test_node_shaped_current_row_is_visible_with_metadata_defaults(self):
        now = "2026-08-26T12:00:00.000Z"
        with sqlite3.connect(self.root / "state" / "registry.sqlite") as conn:
            conn.execute("""INSERT INTO memory_current (
              memory_id,type,content,normalized,normalized_hash,source,confidence,scope,status,created_at,updated_at,tags,valid_from
            ) VALUES (?,'CONTEXT',?,?,?,?,0.9,'profile:main','active',?,?,'[]',?)""",
            ("node-shaped", "Node shaped visible memory", "node shaped visible memory", "a" * 64, "node", now, now, now))
        response = self.client.get("/memories/node-shaped", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "node-shaped")
        self.assertIsNone(response.json().get("concept"))
        self.assertFalse(response.json().get("pinned"))

class MemoryApiReadOnlyProjectionTest(unittest.TestCase):
    def test_read_only_startup_creates_nothing_and_denies_mutations(self):
        with tempfile.TemporaryDirectory(prefix="memory-api-readonly-") as temp:
            root = Path(temp)
            module = load_app("memory_api_projection_read_only", root, True)
            self.assertFalse((root / "state").exists())
            from fastapi.testclient import TestClient
            with TestClient(module.app) as client:
                response = client.post("/memories", headers={"X-GB-Token": "synthetic-projection-token"}, json={"content": "blocked"})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": "Memory API is read-only"})
            self.assertFalse((root / "state").exists())
            self.assertFalse((root / "docs").exists())
            self.assertFalse((root / "output").exists())

if __name__ == "__main__":
    unittest.main()
