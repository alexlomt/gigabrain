import importlib.util
import hashlib
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PATH = REPO_ROOT / "memory_api" / "app.py"

def load_app(name, root, read_only=False):
    previous = os.environ.copy()
    os.environ.update({
        "GB_REGISTRY_PATH": str(root / "state" / "registry.sqlite"),
        "GB_DOCS_PATH": str(root / "docs"),
        "GB_DOC_INDEX_LOCK": str(root / "state" / "doc-index.lock"),
        "GB_OUTPUT_DIR": str(root / "output"),
        "GB_SURFACE_SUMMARY_PATH": str(root / "output" / "surface.json"),
        "GB_UI_TOKEN": "synthetic-projection-token",
        "GB_UI_SCOPE_TOKENS": "{}",
        "GB_API_READ_ONLY": "1" if read_only else "0",
    })
    try:
        spec = importlib.util.spec_from_file_location(name, APP_PATH)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        os.environ.clear()
        os.environ.update(previous)


def run_node_projection(script, *args):
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script, *(str(arg) for arg in args)],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)

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
        unicode_value = "[m:12345678-abcd] Grüße 東京 — Café １２３"
        self.assertEqual(self.module.normalize_content(unicode_value), "grüße 東京 café １２３")
        self.assertEqual(self.module.normalized_hash(unicode_value), "06731553c4e09eaab3f8ddf4f9745c88cf7988b396fb9d230e41784182bf02c7")
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
        merged = self.client.post("/memories/merge", headers=self.headers, json={"ids": [keep, loser]})
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

    def test_short_memory_marker_and_hash_match_node(self):
        value = "[m:a] Grüße 東京 — Café １２３"
        self.assertEqual(self.module.normalize_content(value), "m a grüße 東京 café １２３")
        self.assertEqual(
            self.module.normalized_hash(value),
            "0dc5afc843a25400409edc1a84a6f8972e6b12dd82785179828f30c3d11cda6b",
        )

    def test_api_timestamps_are_canonical_node_iso_strings(self):
        created = self.client.post("/memories", headers=self.headers, json={
            "content": "Synthetic timestamp normalization memory",
            "content_time": "2026-08-26T14:34:56+02:00",
            "valid_until": "2026-09-26T12:34:56+00:00",
            "last_confirmed_at": "2026-08-26T12:34:56.123456+00:00",
        })
        self.assertEqual(created.status_code, 200, created.text)
        memory_id = created.json()["id"]

        updated = self.client.patch(f"/memories/{memory_id}", headers=self.headers, json={
            "content_time": "2026-08-27T00:00:00+00:00",
            "valid_until": "2026-09-27T00:00:00+00:00",
            "last_injected_at": "2026-08-27T01:02:03+00:00",
        })
        self.assertEqual(updated.status_code, 200, updated.text)

        expected = {
            "content_time": "2026-08-27T00:00:00.000Z",
            "valid_until": "2026-09-27T00:00:00.000Z",
            "last_injected_at": "2026-08-27T01:02:03.000Z",
            "last_confirmed_at": "2026-08-26T12:34:56.123Z",
        }
        current = self.rows(
            "SELECT content_time, valid_until FROM memory_current WHERE memory_id=?",
            (memory_id,),
        )[0]
        metadata = self.rows(
            "SELECT last_injected_at, last_confirmed_at FROM memory_console_metadata WHERE memory_id=?",
            (memory_id,),
        )[0]
        legacy = self.rows(
            "SELECT content_time, valid_until, last_injected_at, last_confirmed_at FROM memories WHERE id=?",
            (memory_id,),
        )[0]
        self.assertEqual(current, {key: expected[key] for key in ("content_time", "valid_until")})
        self.assertEqual(metadata, {key: expected[key] for key in ("last_injected_at", "last_confirmed_at")})
        self.assertEqual(legacy, expected)

    def test_every_python_memory_mutation_uses_reviewed_node_canonical_rows(self):
        created = self.client.post("/memories", headers=self.headers, json={
            "id": "python-canonical",
            "content": "  [m:a] Mixed CASE Grüße 東京  ",
            "type": " decision ",
            "status": " PENDING ",
            "scope": " DEFAULT ",
            "source": " user ",
            "tags": ["Mixed", "東京"],
            "content_time": "2001-02-03",
            "valid_until": "not-a-timestamp",
            "last_confirmed_at": "not-a-timestamp",
        })
        self.assertEqual(created.status_code, 200, created.text)
        first = self.rows("SELECT * FROM memory_current WHERE memory_id='python-canonical'")[0]
        self.assertEqual({key: first[key] for key in (
            "type", "content", "normalized", "normalized_hash", "source", "scope", "status",
            "tags", "content_time", "valid_until", "valid_from",
        )}, {
            "type": "DECISION",
            "content": "[m:a] Mixed CASE Grüße 東京",
            "normalized": "m a mixed case grüße 東京",
            "normalized_hash": "747170b4093c5df116a297375c00148002a01a5e5b1783667dd2a18c4cf339cf",
            "source": " user ",
            "scope": "shared",
            "status": "pending",
            "tags": '["Mixed","東京"]',
            "content_time": "2001-02-03",
            "valid_until": None,
            "valid_from": "2001-02-03T00:00:00.000Z",
        })
        self.assertEqual(first["created_at"], first["updated_at"])
        metadata = self.rows(
            "SELECT last_confirmed_at FROM memory_console_metadata WHERE memory_id='python-canonical'"
        )[0]
        self.assertIsNone(metadata["last_confirmed_at"])
        event = self.rows(
            "SELECT payload FROM memory_events WHERE memory_id='python-canonical' ORDER BY rowid"
        )[0]
        self.assertEqual(json.loads(event["payload"]), {
            "operation_id": "api-create-python-canonical",
            "projection_event_kind": "row",
            "projection_mutation": "upsert",
        })

        updated = self.client.patch("/memories/python-canonical", headers=self.headers, json={
            "type": " context ",
            "status": "not-a-status",
            "valid_until": "2026-09-26T14:30:00+02:00",
            "last_injected_at": "not-a-timestamp",
        })
        self.assertEqual(updated.status_code, 200, updated.text)
        second = self.rows("SELECT * FROM memory_current WHERE memory_id='python-canonical'")[0]
        self.assertEqual({key: second[key] for key in (
            "type", "content", "scope", "status", "content_time", "valid_until", "valid_from", "created_at",
        )}, {
            "type": "CONTEXT",
            "content": "[m:a] Mixed CASE Grüße 東京",
            "scope": "shared",
            "status": "active",
            "content_time": "2001-02-03",
            "valid_until": "2026-09-26T12:30:00.000Z",
            "valid_from": "2001-02-03T00:00:00.000Z",
            "created_at": first["created_at"],
        })
        self.assertIsNone(self.rows(
            "SELECT last_injected_at FROM memory_console_metadata WHERE memory_id='python-canonical'"
        )[0]["last_injected_at"])

        rejected = self.client.post("/memories/python-canonical/reject", headers=self.headers)
        self.assertEqual(rejected.status_code, 200, rejected.text)
        status_row = self.rows(
            "SELECT type,content,scope,status,updated_at,last_reviewed_at FROM memory_current "
            "WHERE memory_id='python-canonical'"
        )[0]
        self.assertEqual(status_row["type"], "CONTEXT")
        self.assertEqual(status_row["content"], "[m:a] Mixed CASE Grüße 東京")
        self.assertEqual(status_row["scope"], "shared")
        self.assertEqual(status_row["status"], "rejected")
        self.assertEqual(status_row["last_reviewed_at"], status_row["updated_at"])

        future = self.client.post("/memories", headers=self.headers, json={
            "id": "python-future",
            "content": "  Future trusted ingest clock  ",
            "scope": " Project:Alpha ",
            "content_time": "2999-01-01T00:00:00+01:00",
        })
        self.assertEqual(future.status_code, 200, future.text)
        future_row = self.rows("SELECT * FROM memory_current WHERE memory_id='python-future'")[0]
        self.assertEqual(future_row["content"], "Future trusted ingest clock")
        self.assertEqual(future_row["scope"], "Project:Alpha")
        self.assertEqual(
            future_row["content_time"],
            future_row["created_at"],
            "future content_time must clamp to the trusted batch clock",
        )
        self.assertEqual(future_row["valid_from"], future_row["created_at"])
        self.assertEqual(future_row["updated_at"], future_row["created_at"])

        invalid_scope = self.client.post("/memories", headers=self.headers, json={
            "content": "Invalid scope must not reach a projection write",
            "scope": "project:bad scope",
        })
        self.assertEqual(invalid_scope.status_code, 422, invalid_scope.text)

    def test_python_and_node_observe_each_others_real_canonical_rows(self):
        created = self.client.post("/memories", headers=self.headers, json={
            "id": "python-to-node",
            "content": "  Python to Node Mixed CASE Grüße 東京  ",
            "type": " decision ",
            "status": " PENDING ",
            "scope": " DEFAULT ",
            "content_time": "2001-02-03",
            "valid_until": "not-a-timestamp",
        })
        self.assertEqual(created.status_code, 200, created.text)
        patched = self.client.patch("/memories/python-to-node", headers=self.headers, json={
            "status": "invalid-status",
            "valid_until": "2026-09-26T14:30:00+02:00",
        })
        self.assertEqual(patched.status_code, 200, patched.text)

        observed = run_node_projection("""
          import { openDatabase } from './lib/core/sqlite.js';
          import { getCurrentMemory, listCurrentMemories, searchCurrentMemories } from './lib/core/projection-store.js';
          const [dbPath, memoryId] = process.argv.slice(1);
          const db = openDatabase(dbPath, { observational: true, readOnly: true });
          try {
            const row = getCurrentMemory(db, memoryId, { ensure: false });
            const listed = listCurrentMemories(db, {
              ensure: false, limit: 100, scope: 'shared', statuses: ['ACTIVE'],
            }).some((item) => item.memory_id === memoryId);
            const recalled = searchCurrentMemories(db, {
              ensure: false, query: 'Mixed CASE Grüße', scope: 'shared', statuses: ['ACTIVE'], topK: 10,
            }).some((item) => item.memory_id === memoryId);
            console.log(JSON.stringify({
              listed,
              recalled,
              row: Object.fromEntries([
                'memory_id', 'type', 'content', 'normalized', 'normalized_hash', 'scope', 'status',
                'content_time', 'valid_until', 'valid_from',
              ].map((key) => [key, row[key]])),
            }));
          } finally {
            db.close();
          }
        """, self.root / "state" / "registry.sqlite", "python-to-node")
        self.assertTrue(observed["listed"])
        self.assertTrue(observed["recalled"])
        self.assertEqual(observed["row"], {
            "memory_id": "python-to-node",
            "type": "DECISION",
            "content": "Python to Node Mixed CASE Grüße 東京",
            "normalized": "python to node mixed case grüße 東京",
            "normalized_hash": "655cb26ee904681fd39ede26cf745ade3a814486600aafc025a5087e4a7761e6",
            "scope": "shared",
            "status": "active",
            "content_time": "2001-02-03",
            "valid_until": "2026-09-26T12:30:00.000Z",
            "valid_from": "2001-02-03T00:00:00.000Z",
        })

        node_written = run_node_projection("""
          import { openDatabase } from './lib/core/sqlite.js';
          import { upsertCurrentMemory } from './lib/core/projection-store.js';
          const [dbPath] = process.argv.slice(1);
          const db = openDatabase(dbPath);
          try {
            const row = upsertCurrentMemory(db, {
              memory_id: 'node-to-python',
              content: '  Node to Python Mixed CASE Grüße  ',
              type: ' preference ',
              status: ' PENDING ',
              scope: ' DEFAULT ',
              content_time: '2002-03-04',
              valid_until: 'not-a-timestamp',
            }, { now: '2026-08-27T10:00:00.000Z', operationId: 'node-to-python' });
            console.log(JSON.stringify(row));
          } finally {
            db.close();
          }
        """, self.root / "state" / "registry.sqlite")
        self.assertEqual(node_written["content"], "Node to Python Mixed CASE Grüße")
        response = self.client.get("/memories/node-to-python", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({key: response.json()[key] for key in (
            "id", "type", "content", "normalized", "scope", "status", "content_time", "valid_until",
        )}, {
            "id": "node-to-python",
            "type": "PREFERENCE",
            "content": "Node to Python Mixed CASE Grüße",
            "normalized": "node to python mixed case grüße",
            "scope": "shared",
            "status": "pending",
            "content_time": "2002-03-04",
            "valid_until": None,
        })

    def test_empty_normalized_rows_match_node_in_both_directions(self):
        created = self.client.post("/memories", headers=self.headers, json={
            "id": "python-empty-normalized",
            "content": "!!!",
        })
        self.assertEqual(created.status_code, 200, created.text)
        current = self.rows(
            "SELECT normalized,normalized_hash FROM memory_current "
            "WHERE memory_id='python-empty-normalized'"
        )[0]
        legacy = self.rows(
            "SELECT normalized FROM memories WHERE id='python-empty-normalized'"
        )[0]
        self.assertEqual(current, {"normalized": "", "normalized_hash": ""})
        self.assertEqual(legacy, {"normalized": ""})
        events = self.rows(
            "SELECT payload FROM memory_events WHERE memory_id='python-empty-normalized' ORDER BY rowid"
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(json.loads(events[0]["payload"])["projection_event_kind"], "row")

        observed = run_node_projection("""
          import { openDatabase } from './lib/core/sqlite.js';
          import { getCurrentMemory, upsertCurrentMemory } from './lib/core/projection-store.js';
          const [dbPath] = process.argv.slice(1);
          const db = openDatabase(dbPath);
          try {
            const pythonRow = getCurrentMemory(db, 'python-empty-normalized', { ensure: false });
            const nodeRow = upsertCurrentMemory(db, {
              memory_id: 'node-empty-normalized', content: '!!!', scope: 'shared',
            }, { now: '2026-08-27T10:00:00.000Z', operationId: 'node-empty-normalized' });
            console.log(JSON.stringify({
              node: { normalized: nodeRow.normalized, normalized_hash: nodeRow.normalized_hash },
              python: { normalized: pythonRow.normalized, normalized_hash: pythonRow.normalized_hash },
            }));
          } finally {
            db.close();
          }
        """, self.root / "state" / "registry.sqlite")
        self.assertEqual(observed, {
            "node": {"normalized": "", "normalized_hash": ""},
            "python": {"normalized": "", "normalized_hash": ""},
        })

        response = self.client.get("/memories/node-empty-normalized", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["content"], "!!!")
        self.assertEqual(response.json()["normalized"], "")


class MemoryApiLegacyUpgradeTest(unittest.TestCase):
    def test_pre_task11_legacy_schema_is_upgraded_additively(self):
        with tempfile.TemporaryDirectory(prefix="memory-api-legacy-upgrade-") as temp:
            root = Path(temp)
            db_path = root / "state" / "registry.sqlite"
            db_path.parent.mkdir(parents=True)
            old_columns = (
                "id", "type", "content", "normalized", "concept", "source", "source_agent",
                "source_session", "source_message_id", "confidence", "status", "scope", "tags",
                "created_at", "updated_at", "last_injected_at", "last_confirmed_at", "ttl_days",
                "content_time", "valid_until", "pinned", "superseded_by",
            )
            old_values = (
                "legacy-sentinel", "DECISION", "Legacy sentinel remains byte-for-byte logical data",
                "legacy sentinel remains byte for byte logical data", "legacy-concept", "user", "main",
                "session-old", "message-old", 0.81, "active", "profile:main", '["legacy"]',
                "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z", None,
                "2026-08-03T00:00:00Z", 30, "2026-07-31T00:00:00Z",
                "2026-09-01T00:00:00Z", 1, None,
            )
            with sqlite3.connect(db_path) as conn:
                conn.execute("""CREATE TABLE memories (
                    id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
                    normalized TEXT NOT NULL, concept TEXT, source TEXT NOT NULL,
                    source_agent TEXT, source_session TEXT, source_message_id TEXT,
                    confidence REAL, status TEXT, scope TEXT, tags TEXT, created_at TEXT,
                    updated_at TEXT, last_injected_at TEXT, last_confirmed_at TEXT,
                    ttl_days INTEGER, content_time TEXT, valid_until TEXT,
                    pinned INTEGER DEFAULT 0, superseded_by TEXT
                )""")
                placeholders = ",".join("?" for _ in old_columns)
                conn.execute(
                    f"INSERT INTO memories ({','.join(old_columns)}) VALUES ({placeholders})",
                    old_values,
                )

            module = load_app("memory_api_projection_legacy_upgrade", root, False)
            from fastapi.testclient import TestClient
            headers = {"X-GB-Token": "synthetic-projection-token"}
            with TestClient(module.app) as client:
                with sqlite3.connect(db_path) as conn:
                    columns = {row[1] for row in conn.execute("PRAGMA table_info(memories)")}
                    preserved = conn.execute(
                        f"SELECT {','.join(old_columns)} FROM memories WHERE id='legacy-sentinel'"
                    ).fetchone()
                    metadata_count = conn.execute(
                        "SELECT COUNT(*) FROM memory_console_metadata WHERE memory_id='legacy-sentinel'"
                    ).fetchone()[0]
                self.assertTrue({
                    "value_score", "value_label", "review_version", "review_reason", "archived_at",
                    "last_reviewed_at", "source_layer", "source_path", "source_line", "source_host",
                    "source_kind", "sync_policy",
                }.issubset(columns))
                self.assertEqual(preserved, old_values)
                self.assertEqual(metadata_count, 0, "normal startup must not backfill legacy metadata")

                created = client.post("/memories", headers=headers, json={
                    "content": "Synthetic post-upgrade memory", "concept": "post-upgrade",
                    "review_version": "rv-create", "review_reason": "created-after-upgrade",
                })
                self.assertEqual(created.status_code, 200, created.text)
                memory_id = created.json()["id"]
                updated = client.patch(f"/memories/{memory_id}", headers=headers, json={
                    "review_version": "rv-update", "review_reason": "updated-after-upgrade",
                })
                self.assertEqual(updated.status_code, 200, updated.text)

                with sqlite3.connect(db_path) as conn:
                    sidecar = conn.execute(
                        "SELECT review_version, review_reason FROM memory_console_metadata WHERE memory_id=?",
                        (memory_id,),
                    ).fetchone()
                    legacy = conn.execute(
                        "SELECT review_version, review_reason FROM memories WHERE id=?",
                        (memory_id,),
                    ).fetchone()
                self.assertEqual(sidecar, ("rv-update", "updated-after-upgrade"))
                self.assertEqual(legacy, sidecar)

class MemoryApiReadOnlyProjectionTest(unittest.TestCase):
    def test_read_only_startup_creates_nothing_and_denies_mutations(self):
        with tempfile.TemporaryDirectory(prefix="memory-api-readonly-") as temp:
            root = Path(temp)
            module = load_app("memory_api_projection_read_only", root, True)
            self.assertFalse((root / "state").exists())
            from fastapi.testclient import TestClient
            with TestClient(module.app) as client:
                read = client.get("/memories", headers={"X-GB-Token": "synthetic-projection-token"})
                self.assertEqual(read.status_code, 503)
                response = client.post("/memories", headers={"X-GB-Token": "synthetic-projection-token"}, json={"content": "blocked"})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": "Memory API is read-only"})
            self.assertFalse((root / "state").exists())
            self.assertFalse((root / "docs").exists())
            self.assertFalse((root / "output").exists())

    def test_checkpointed_wal_without_sidecars_fails_closed_and_mutations_are_early_denied(self):
        with tempfile.TemporaryDirectory(prefix="memory-api-readonly-existing-") as temp:
            root = Path(temp)
            writable = load_app("memory_api_projection_writable_seed", root, False)
            from fastapi.testclient import TestClient
            with TestClient(writable.app) as client:
                created = client.post("/memories", headers={"X-GB-Token": "synthetic-projection-token"}, json={
                    "content": "Synthetic read-only visible memory", "scope": "shared",
                })
                self.assertEqual(created.status_code, 200, created.text)
                memory_id = created.json()["id"]
                doc = client.post("/docs", headers={"X-GB-Token": "synthetic-projection-token"}, json={
                    "title": "Synthetic doc", "content": "Synthetic doc content",
                })
                self.assertEqual(doc.status_code, 200, doc.text)
                doc_id = doc.json()["id"]

            def vector():
                rows = []
                for target in sorted(root.rglob("*")):
                    relative = str(target.relative_to(root))
                    if target.is_file():
                        rows.append((relative, hashlib.sha256(target.read_bytes()).hexdigest()))
                    else:
                        rows.append((relative, "dir"))
                return rows

            before = vector()
            db_path = root / "state" / "registry.sqlite"
            header = db_path.read_bytes()[:20]
            self.assertEqual((header[18], header[19]), (2, 2), "fixture must remain WAL-mode")
            self.assertFalse(Path(f"{db_path}-wal").exists())
            self.assertFalse(Path(f"{db_path}-shm").exists())
            readonly = load_app("memory_api_projection_read_only_existing", root, True)
            with TestClient(readonly.app) as client:
                read = client.get(f"/memories/{memory_id}", headers={"X-GB-Token": "synthetic-projection-token"})
                self.assertEqual(read.status_code, 503, read.text)
                requests = [
                    ("post", "/memories", {"json": {"content": "blocked"}}),
                    ("patch", f"/memories/{memory_id}", {"json": {"content": "blocked"}}),
                    ("post", f"/memories/{memory_id}/confirm", {}),
                    ("post", f"/memories/{memory_id}/reject", {}),
                    ("post", "/memories/merge", {"json": {"ids": [memory_id, "other"]}}),
                    ("post", "/docs", {"json": {"content": "blocked"}}),
                    ("post", "/docs/url", {"json": {"url": "https://example.com/blocked"}}),
                    ("post", "/docs/file", {"files": {"file": ("blocked.txt", b"blocked", "text/plain")}}),
                    ("patch", f"/docs/{doc_id}", {"json": {"title": "blocked"}}),
                    ("delete", f"/docs/{doc_id}", {}),
                ]
                for method, url, kwargs in requests:
                    with self.subTest(method=method, url=url):
                        response = getattr(client, method)(url, headers={"X-GB-Token": "synthetic-projection-token"}, **kwargs)
                        self.assertEqual(response.status_code, 503, response.text)
                        self.assertEqual(response.json(), {"detail": "Memory API is read-only"})
            self.assertEqual(vector(), before)

    def test_read_only_api_sees_uncheckpointed_wal_rows_without_writing(self):
        with tempfile.TemporaryDirectory(prefix="memory-api-readonly-wal-") as temp:
            root = Path(temp)
            writable = load_app("memory_api_projection_wal_seed", root, False)
            from fastapi.testclient import TestClient
            with TestClient(writable.app):
                pass

            db_path = root / "state" / "registry.sqlite"
            writer = sqlite3.connect(db_path)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                timestamp = "2026-08-27T02:00:00.000Z"
                writer.execute("""INSERT INTO memory_current (
                    memory_id,type,content,normalized,normalized_hash,source,confidence,
                    scope,status,created_at,updated_at,tags,valid_from
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    "wal-only", "CONTEXT", "Uncheckpointed WAL memory", "uncheckpointed wal memory",
                    "7" * 64, "synthetic", 0.9, "shared", "active", timestamp, timestamp, "[]", timestamp,
                ))
                writer.commit()
                self.assertTrue(Path(f"{db_path}-wal").exists())
                self.assertGreater(Path(f"{db_path}-wal").stat().st_size, 0)

                def file_paths():
                    return {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}

                def durable_vector():
                    return [
                        (str(path.relative_to(root)), hashlib.sha256(path.read_bytes()).hexdigest())
                        for path in sorted(root.rglob("*"))
                        if path.is_file() and not str(path).endswith("-shm")
                    ]

                paths_before = file_paths()
                durable_before = durable_vector()
                readonly = load_app("memory_api_projection_wal_reader", root, True)
                with TestClient(readonly.app) as client:
                    response = client.get(
                        "/memories/wal-only",
                        headers={"X-GB-Token": "synthetic-projection-token"},
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["content"], "Uncheckpointed WAL memory")
                self.assertEqual(file_paths(), paths_before)
                self.assertEqual(durable_vector(), durable_before)
            finally:
                writer.close()

if __name__ == "__main__":
    unittest.main()
