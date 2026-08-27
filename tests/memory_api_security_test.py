import asyncio
import importlib.util
import os
import sqlite3
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch
import base64
import hashlib
import re

from pydantic import ValidationError


REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PATH = REPO_ROOT / "memory_api" / "app.py"


class MemoryApiSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_base = Path(os.getenv("GIGABRAIN_TEST_TMPDIR", tempfile.gettempdir()))
        cls.temp_base.mkdir(parents=True, exist_ok=True)
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="memory-api-", dir=cls.temp_base)
        root = Path(cls.temp_dir.name)
        cls.root = root
        os.environ.update({
            "GB_REGISTRY_PATH": str(root / "state" / "registry.sqlite"),
            "GB_DOCS_PATH": str(root / "docs"),
            "GB_DOC_INDEX_LOCK": str(root / "state" / "doc-index.lock"),
            "GB_OUTPUT_DIR": str(root / "output"),
            "GB_SURFACE_SUMMARY_PATH": str(root / "output" / "surface.json"),
            "GB_UI_TOKEN": "synthetic-test-token",
            "GB_UI_SCOPE_TOKENS": '{"team-red":"synthetic-scoped-token"}',
            "GB_ENABLE_URL_IMPORT": "false",
            "GB_URL_IMPORT_ALLOWLIST": "example.com",
            "GB_MAX_JSON_BODY_BYTES": "65536",
            "GB_MAX_MULTIPART_BODY_BYTES": "65536",
            "GB_API_READ_ONLY": "0",
        })
        spec = importlib.util.spec_from_file_location("gigabrain_memory_api_test", APP_PATH)
        cls.module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(cls.module)
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.module.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        cls.temp_dir.cleanup()

    def test_auth_and_security_headers(self):
        unauthorized = self.client.get("/memories")
        self.assertEqual(unauthorized.status_code, 401)
        response = self.client.get("/memories", headers={"X-GB-Token": "synthetic-test-token"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        csp = response.headers["content-security-policy"]
        self.assertIn("default-src 'self'", csp)
        self.assertIn("script-src 'self'", csp)
        self.assertIn("connect-src 'self'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertNotIn("'unsafe-inline'", csp)
        html_bytes = (REPO_ROOT / "memory_api" / "static" / "index.html").read_bytes()
        for tag in (b"script", b"style"):
            matches = re.findall(
                rb"<" + tag + rb"(?:\s[^>]*)?>(.*?)</" + tag + rb">",
                html_bytes,
                flags=re.DOTALL | re.IGNORECASE,
            )
            self.assertEqual(len(matches), 1)
            digest = base64.b64encode(hashlib.sha256(matches[0]).digest()).decode("ascii")
            self.assertIn(f"'sha256-{digest}'", csp)

        unicode_token = self.client.get(
            "/memories",
            headers={b"X-GB-Token": b"synthetic-\xff-token"},
        )
        self.assertEqual(unicode_token.status_code, 401)

    def test_console_has_no_third_party_browser_assets(self):
        html = (REPO_ROOT / "memory_api" / "static" / "index.html").read_text(encoding="utf-8").lower()
        for marker in ('src="http', 'href="http', "@import url('http", '@import url("http'):
            with self.subTest(marker=marker):
                self.assertNotIn(marker, html)
        self.assertNotIn("fonts.googleapis.com", html)
        self.assertNotIn("unpkg.com", html)
        self.assertIn("const conceptcheckboxid = index =>", html)
        self.assertIn("getelementbyid(conceptcheckboxid(index))", html)
        self.assertNotIn("concept-chk-${escapehtml(r.id)}", html)

    def test_every_data_route_declares_token_auth(self):
        from fastapi.routing import APIRoute
        public_paths = {"/", "/_docs", "/_redoc", "/openapi.json"}
        missing = []
        for route in self.module.app.routes:
            if not isinstance(route, APIRoute) or route.path in public_paths:
                continue
            dependency_calls = {dependency.call for dependency in route.dependant.dependencies}
            if self.module.require_token not in dependency_calls:
                missing.append(f"{','.join(sorted(route.methods or []))} {route.path}")
        self.assertEqual(missing, [], f"data routes missing require_token: {missing}")

    def test_iso_parser_is_utc_aware_and_expiry_is_enforced(self):
        parse = self.module._parse_iso
        for value in ("2026-08-06T12:00:00Z", "2026-08-06T12:00:00+00:00Z", "2026-08-06T12:00:00"):
            parsed = parse(value)
            self.assertIsNotNone(parsed)
            self.assertIsNotNone(parsed.tzinfo)
            self.assertEqual(parsed.utcoffset().total_seconds(), 0)
        self.assertTrue(self.module._is_expired(
            {"valid_until": "2020-01-01T00:00:00Z", "ttl_days": None},
            datetime.now(timezone.utc),
        ))

    def test_url_import_is_disabled_and_ssrf_shapes_are_rejected(self):
        response = self.client.post(
            "/docs/url",
            headers={"X-GB-Token": "synthetic-test-token"},
            json={"url": "https://example.com/article"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.module.is_public_http_url("http://127.0.0.1/private"))
        self.assertFalse(self.module.is_public_http_url("http://user:pass@example.com/"))
        self.assertFalse(self.module.is_public_http_url("https://example.com:8443/"))
        self.assertFalse(self.module.is_public_http_url("http://example.com:443/"))
        self.assertFalse(self.module.is_public_http_url("https://example.com/article#fragment"))

    def test_url_import_pins_the_validated_public_address(self):
        synthetic_public_address = "192.0.2.44"
        public = (
            self.module.socket.AF_INET,
            self.module.socket.SOCK_STREAM,
            6,
            "",
            (synthetic_public_address, 443),
        )
        private = (
            self.module.socket.AF_INET,
            self.module.socket.SOCK_STREAM,
            6,
            "",
            ("127.0.0.1", 443),
        )
        with patch.object(self.module.socket, "getaddrinfo", return_value=[public]), patch.object(
            self.module, "_address_is_private", side_effect=lambda address: address != synthetic_public_address
        ):
            parsed, host, address, port = self.module._resolve_url_import_target(
                "https://example.com/article"
            )
            self.assertEqual(parsed.scheme, "https")
            self.assertEqual(host, "example.com")
            self.assertEqual(address, synthetic_public_address)
            self.assertEqual(port, 443)
        with patch.object(self.module.socket, "getaddrinfo", return_value=[private]):
            with self.assertRaises(self.module.HTTPException):
                self.module._resolve_url_import_target("https://example.com/article")
        with patch.object(self.module.socket, "getaddrinfo", return_value=[private, public]), patch.object(
            self.module, "_address_is_private", side_effect=lambda address: address != synthetic_public_address
        ):
            _, _, address, _ = self.module._resolve_url_import_target("https://example.com/article")
            self.assertEqual(address, synthetic_public_address, "the request socket must receive a validated public address")

    def test_document_ids_are_hashed_instead_of_sanitized_as_paths(self):
        first = self.module._safe_doc_filename("d:a/b")
        second = self.module._safe_doc_filename("d:ab")
        self.assertNotEqual(first, second, "distinct identifiers must not collapse onto one file")
        self.assertRegex(first, r"^[a-f0-9]{64}$")
        file_path = self.module.write_doc_file(
            "d:a/b\nmetadata: blocked",
            "Synthetic title",
            "text",
            "",
            [],
            "Synthetic content",
            "2026-08-07T00:00:00Z",
        )
        self.assertEqual(Path(file_path).parent.resolve(), (self.root / "docs").resolve())
        written = Path(file_path).read_text(encoding="utf-8")
        self.assertIn('id: "d:a/b metadata: blocked"', written)
        self.assertNotIn("\nmetadata:", written)

    def test_upload_limit_is_applied_during_read(self):
        original_limit = self.module.MAX_UPLOAD_BYTES
        self.module.MAX_UPLOAD_BYTES = 16
        try:
            response = self.client.post(
                "/docs/file",
                headers={"X-GB-Token": "synthetic-test-token"},
                files={"file": ("oversized.txt", b"x" * 17, "text/plain")},
            )
            self.assertEqual(response.status_code, 413)
        finally:
            self.module.MAX_UPLOAD_BYTES = original_limit

        multipart = self.client.post(
            "/docs/file",
            headers={"X-GB-Token": "synthetic-test-token"},
            files={"file": ("oversized.txt", b"x" * 70_000, "text/plain")},
        )
        self.assertEqual(multipart.status_code, 413)
        self.assertEqual(multipart.json(), {"detail": "multipart body too large"})

    def test_rate_limit_keys_hide_tokens_and_bucket_map_is_bounded(self):
        from starlette.requests import Request
        def request_for(token, path="/memories"):
            return Request({
                "type": "http",
                "method": "GET",
                "path": path,
                "raw_path": path.encode("utf-8"),
                "query_string": b"",
                "headers": [(b"x-gb-token", token.encode("utf-8"))],
                "client": ("127.0.0.1", 1234),
                "server": ("127.0.0.1", 80),
                "scheme": "http",
            })

        key = self.module._rate_limit_key(request_for("synthetic-test-token"))
        self.assertNotIn("synthetic-test-token", key)
        invalid_one = self.module._rate_limit_key(request_for("invalid-token-one"))
        invalid_two = self.module._rate_limit_key(request_for("invalid-token-two", "/docs"))
        self.assertEqual(invalid_one, invalid_two, "invalid-token rotation must share the peer bucket")
        self.assertNotEqual(key, invalid_one, "authenticated and unauthenticated clients need distinct buckets")

        original_limit = self.module.MAX_RATE_LIMIT_BUCKETS
        original_buckets = self.module._rate_limit_buckets
        self.module.MAX_RATE_LIMIT_BUCKETS = 3
        self.module._rate_limit_buckets = {
            "a": deque([10.0]), "b": deque([20.0]), "c": deque([30.0]),
        }
        try:
            self.module._prune_rate_limit_buckets(0.0)
            self.assertLessEqual(len(self.module._rate_limit_buckets), 2)
        finally:
            self.module.MAX_RATE_LIMIT_BUCKETS = original_limit
            self.module._rate_limit_buckets = original_buckets

    def test_pagination_bounds_are_enforced(self):
        headers = {"X-GB-Token": "synthetic-test-token"}
        for path in (
            "/memories?limit=501",
            "/concepts?offset=-1",
            "/audit?limit=0",
            "/docs?offset=-1",
            "/profile?max_static_items=501",
            "/profile?dynamic_window_days=0",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers=headers).status_code, 422)
        bounded_audit = self.client.get("/audit?limit=1", headers=headers)
        self.assertEqual(bounded_audit.status_code, 200)
        self.assertEqual(bounded_audit.headers["x-audit-scan-truncated"], "false")

    def test_json_body_and_collection_bounds_are_enforced(self):
        headers = {"X-GB-Token": "synthetic-test-token"}
        oversized_body = self.client.post(
            "/memories",
            headers=headers,
            json={"content": "x" * self.module.MAX_JSON_BODY_BYTES},
        )
        self.assertEqual(oversized_body.status_code, 413)
        self.assertEqual(oversized_body.json(), {"detail": "JSON body too large"})

        too_many_tags = self.client.post(
            "/memories",
            headers=headers,
            json={"content": "Synthetic bounded tags fixture", "tags": ["tag"] * 101},
        )
        self.assertEqual(too_many_tags.status_code, 422)
        oversized_tag = self.client.post(
            "/memories",
            headers=headers,
            json={"content": "Synthetic bounded tag fixture", "tags": ["x" * 129]},
        )
        self.assertEqual(oversized_tag.status_code, 422)
        too_many_merge_ids = self.client.post(
            "/memories/merge",
            headers=headers,
            json={"ids": [f"synthetic-memory-{index}" for index in range(101)]},
        )
        self.assertEqual(too_many_merge_ids.status_code, 422)

    def test_document_metadata_fields_are_bounded(self):
        create_cases = (
            {"id": "x" * 129},
            {"title": "x" * 1001},
            {"source": "x" * 257},
            {"url": "x" * 2049},
        )
        for values in create_cases:
            with self.subTest(create=next(iter(values))):
                with self.assertRaises(ValidationError):
                    self.module.DocCreatePayload(content="Synthetic document", **values)

        for values in create_cases[1:]:
            with self.subTest(update=next(iter(values))):
                with self.assertRaises(ValidationError):
                    self.module.DocUpdatePayload(**values)

    def test_chunked_json_without_content_length_is_bounded(self):
        async def exercise():
            downstream_calls = []
            sent = []
            messages = [
                {"type": "http.request", "body": b"12345", "more_body": True},
                {"type": "http.request", "body": b"6789", "more_body": False},
            ]

            async def downstream(scope, receive, send):
                downstream_calls.append(scope)

            async def receive():
                return messages.pop(0)

            async def send(message):
                sent.append(message)

            middleware = self.module.RequestBodyLimitMiddleware(
                downstream,
                json_max_bytes=8,
                multipart_max_bytes=16,
            )
            await middleware(
                {
                    "type": "http",
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/synthetic",
                    "raw_path": b"/synthetic",
                    "query_string": b"",
                    "headers": [(b"content-type", b"application/json")],
                    "client": ("127.0.0.1", 1234),
                    "server": ("127.0.0.1", 80),
                },
                receive,
                send,
            )
            return downstream_calls, sent

        downstream_calls, sent = asyncio.run(exercise())
        self.assertEqual(downstream_calls, [])
        response_start = next(message for message in sent if message["type"] == "http.response.start")
        self.assertEqual(response_start["status"], 413)

    def test_fragmented_json_body_chunk_count_is_bounded(self):
        async def exercise():
            downstream_calls = []
            sent = []
            remaining = self.module.MAX_BODY_CHUNKS + 1

            async def downstream(scope, receive, send):
                downstream_calls.append(scope)

            async def receive():
                nonlocal remaining
                remaining -= 1
                return {
                    "type": "http.request",
                    "body": b"",
                    "more_body": remaining > 0,
                }

            async def send(message):
                sent.append(message)

            middleware = self.module.RequestBodyLimitMiddleware(
                downstream,
                json_max_bytes=64 * 1024,
                multipart_max_bytes=64 * 1024,
            )
            await middleware(
                {
                    "type": "http",
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/synthetic",
                    "raw_path": b"/synthetic",
                    "query_string": b"",
                    "headers": [(b"content-type", b"application/json")],
                    "client": ("127.0.0.1", 1234),
                    "server": ("127.0.0.1", 80),
                },
                receive,
                send,
            )
            return downstream_calls, sent

        downstream_calls, sent = asyncio.run(exercise())
        self.assertEqual(downstream_calls, [])
        response_start = next(message for message in sent if message["type"] == "http.response.start")
        self.assertEqual(response_start["status"], 413)

    def test_duplicate_content_length_headers_are_rejected(self):
        async def exercise():
            downstream_calls = []
            sent = []

            async def downstream(scope, receive, send):
                downstream_calls.append(scope)

            async def receive():
                return {"type": "http.request", "body": b"{}", "more_body": False}

            async def send(message):
                sent.append(message)

            middleware = self.module.RequestBodyLimitMiddleware(
                downstream,
                json_max_bytes=64 * 1024,
                multipart_max_bytes=64 * 1024,
            )
            await middleware(
                {
                    "type": "http",
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/synthetic",
                    "raw_path": b"/synthetic",
                    "query_string": b"",
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", b"2"),
                        (b"content-length", b"3"),
                    ],
                    "client": ("127.0.0.1", 1234),
                    "server": ("127.0.0.1", 80),
                },
                receive,
                send,
            )
            return downstream_calls, sent

        downstream_calls, sent = asyncio.run(exercise())
        self.assertEqual(downstream_calls, [])
        response_start = next(message for message in sent if message["type"] == "http.response.start")
        self.assertEqual(response_start["status"], 400)

    def test_duplicate_memory_id_detection_uses_sqlite_error_code(self):
        opaque_error = sqlite3.IntegrityError("opaque constraint message")
        primary_key_code = getattr(sqlite3, "SQLITE_CONSTRAINT_PRIMARYKEY", 1555)
        opaque_error.sqlite_errorcode = primary_key_code
        self.assertTrue(self.module._is_duplicate_memory_id_error(opaque_error))

    def test_recall_proxy_is_loopback_only(self):
        self.assertTrue(self.module._is_loopback_http_url("http://localhost:18789/gb/recall/explain"))
        self.assertTrue(self.module._is_loopback_http_url("http://127.0.0.1:18789/gb/recall/explain"))
        self.assertTrue(self.module._is_loopback_http_url("http://[::1]:18789/gb/recall/explain"))
        for url in (
            "https://example.com/gb/recall/explain",
            "http://localhost.example.com/gb/recall/explain",
            "http://user:pass@localhost:18789/gb/recall/explain",
        ):
            with self.subTest(url=url):
                self.assertFalse(self.module._is_loopback_http_url(url))

        original_url = self.module.GB_RECALL_EXPLAIN_URL
        original_client = self.module.httpx.Client
        proxy_attempts = []

        def forbidden_client(*args, **kwargs):
            proxy_attempts.append((args, kwargs))
            raise AssertionError("off-host recall proxy must not be opened")

        self.module.GB_RECALL_EXPLAIN_URL = "https://example.com/gb/recall/explain"
        self.module.httpx.Client = forbidden_client
        try:
            response = self.client.post(
                "/recall/explain",
                headers={"X-GB-Token": "synthetic-test-token"},
                json={"query": "clearly synthetic fallback query"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(proxy_attempts, [])
        finally:
            self.module.GB_RECALL_EXPLAIN_URL = original_url
            self.module.httpx.Client = original_client

    def test_duplicate_memory_id_returns_conflict_and_audit_flags_trivial_claim(self):
        headers = {"X-GB-Token": "synthetic-test-token"}
        memory_id = "synthetic-duplicate-memory"
        payload = {
            "id": memory_id,
            "content": "The clearly fictional shared memory is cool",
        }
        created = self.client.post("/memories", headers=headers, json=payload)
        duplicate = self.client.post("/memories", headers=headers, json=payload)
        self.assertEqual(created.status_code, 200)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.json(), {"detail": "Memory id already exists"})

        oversized_id = self.client.post(
            "/memories",
            headers=headers,
            json={"id": "x" * 129, "content": "Clearly fictional bounded-id fixture"},
        )
        self.assertEqual(oversized_id.status_code, 422)

        audit = self.client.get("/audit?limit=500", headers=headers)
        self.assertEqual(audit.status_code, 200)
        finding = next(row for row in audit.json() if row["id"] == memory_id)
        self.assertIn("trivial_or_too_short", finding["reasons"])

    def test_out_of_scope_ids_are_hidden_and_connections_close(self):
        admin_headers = {"X-GB-Token": "synthetic-test-token"}
        scoped_headers = {"X-GB-Token": "synthetic-scoped-token"}
        memory_id = "synthetic-blue-memory"
        created = self.client.post(
            "/memories",
            headers=admin_headers,
            json={
                "id": memory_id,
                "content": "A clearly fictional scoped memory for a route-security test.",
                "scope": "team-blue",
            },
        )
        self.assertEqual(created.status_code, 200)

        original_get_db = self.module.get_db
        connections = []

        class TrackingConnection:
            def __init__(self, inner):
                self.inner = inner
                self.closed = False

            def __getattr__(self, name):
                return getattr(self.inner, name)

            def close(self):
                self.closed = True
                return self.inner.close()

        def tracked_get_db():
            connection = TrackingConnection(original_get_db())
            connections.append(connection)
            return connection

        self.module.get_db = tracked_get_db
        try:
            hidden_get = self.client.get(f"/memories/{memory_id}", headers=scoped_headers)
            hidden_patch = self.client.patch(
                f"/memories/{memory_id}",
                headers=scoped_headers,
                json={"pinned": True},
            )
            opened_before_filter = len(connections)
            forbidden_list = self.client.get(
                "/memories?scope=team-blue",
                headers=scoped_headers,
            )
            self.assertEqual(hidden_get.status_code, 404)
            self.assertEqual(hidden_patch.status_code, 404)
            self.assertEqual(forbidden_list.status_code, 403)
            self.assertEqual(len(connections), opened_before_filter,
                             "scope filters should reject before opening SQLite")
            profile = self.client.get("/profile", headers=admin_headers)
            metrics = self.client.get("/metrics", headers=admin_headers)
            self.assertEqual(profile.status_code, 200)
            self.assertEqual(metrics.status_code, 200)
            self.assertTrue(connections and all(connection.closed for connection in connections))
        finally:
            self.module.get_db = original_get_db

    def test_upload_filename_extension_is_sanitized(self):
        response = self.client.post(
            "/docs/file",
            headers={"X-GB-Token": "synthetic-test-token"},
            files={"file": ("../../payload.sh", b"synthetic text", "text/plain")},
        )
        self.assertEqual(response.status_code, 200)
        raw_files = list((Path(self.module.DOCS_DIR) / "raw").glob("*"))
        self.assertTrue(any(path.suffix == ".bin" for path in raw_files))
        self.assertFalse(any(path.suffix == ".sh" for path in raw_files))

    def test_raw_upload_atomically_replaces_a_preexisting_symlink(self):
        fixed_uuid = uuid.UUID("00000000-0000-4000-8000-000000000001")
        doc_id = f"d:{fixed_uuid}"
        raw_path = Path(self.module.DOCS_DIR) / "raw" / f"{self.module._safe_doc_filename(doc_id)}.txt"
        outside = self.root / "outside-upload-target.txt"
        outside.write_bytes(b"outside stays intact")
        raw_path.unlink(missing_ok=True)
        raw_path.symlink_to(outside)

        with patch.object(self.module.uuid, "uuid4", return_value=fixed_uuid):
            response = self.client.post(
                "/docs/file",
                headers={"X-GB-Token": "synthetic-test-token"},
                files={"file": ("safe.txt", b"synthetic upload", "text/plain")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(outside.read_bytes(), b"outside stays intact")
        self.assertFalse(raw_path.is_symlink())
        self.assertEqual(raw_path.read_bytes(), b"synthetic upload")


if __name__ == "__main__":
    unittest.main()
