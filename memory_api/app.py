from fastapi import FastAPI, HTTPException, Request, Depends, UploadFile, File, Response, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from collections import deque
from contextlib import asynccontextmanager, contextmanager
import http.client
import base64
import hashlib
import sqlite3
import os
import ssl
import tempfile
import uuid
import json
import subprocess
import threading
import time
import math
from io import BytesIO
from datetime import datetime, timedelta, timezone
from typing import Optional, Any, Annotated
import re
import hmac
import logging
import ipaddress
import socket
from urllib.parse import urlparse

import httpx
from readability import Document
from bs4 import BeautifulSoup
from pypdf import PdfReader
from pydantic import BaseModel, ConfigDict, Field

_home = os.path.expanduser("~")
DB_PATH = os.getenv("GB_REGISTRY_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "registry.sqlite"))
TOKEN = os.getenv("GB_UI_TOKEN", "")
OPENCLAW_CONFIG_PATH = os.getenv("GB_OPENCLAW_CONFIG", os.path.join(_home, ".openclaw", "openclaw.json"))
DOCS_DIR = os.getenv("GB_DOCS_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "docs"))
DOC_INDEX_AGENT = os.getenv("GB_DOC_INDEX_AGENT", "shared-docs")
DOC_INDEX_DEBOUNCE_SECONDS = int(os.getenv("GB_DOC_INDEX_DEBOUNCE", "10"))
DOC_INDEX_TIMEOUT_SECONDS = int(os.getenv("GB_DOC_INDEX_TIMEOUT", "900"))
DOC_INDEX_LOCK_PATH = os.getenv("GB_DOC_INDEX_LOCK", os.path.join(_home, ".openclaw", "gigabrain", "memory", ".doc-index.lock"))
GRAPH_PATH = os.getenv("GB_GRAPH_PATH", os.path.join(_home, ".openclaw", "gigabrain", "memory", "graph.json"))
OUTPUT_DIR = os.getenv("GB_OUTPUT_DIR", os.path.realpath(os.path.join(os.path.dirname(DB_PATH), "..", "output")))
SURFACE_SUMMARY_PATH = os.getenv("GB_SURFACE_SUMMARY_PATH", os.path.join(OUTPUT_DIR, "memory-surface-summary.json"))
GB_RECALL_EXPLAIN_URL = os.getenv("GB_RECALL_EXPLAIN_URL", "http://127.0.0.1:18789/gb/recall/explain")
ALLOW_PRIVATE_URLS = os.getenv("GB_ALLOW_PRIVATE_URLS", "").lower() in ("1", "true", "yes")
ENABLE_URL_IMPORT = os.getenv("GB_ENABLE_URL_IMPORT", "").lower() in ("1", "true", "yes")
URL_IMPORT_ALLOWLIST = {
    host.strip().lower().rstrip(".")
    for host in os.getenv("GB_URL_IMPORT_ALLOWLIST", "").split(",")
    if host.strip()
}
ENABLE_API_DOCS = os.getenv("GB_ENABLE_API_DOCS", "").lower() in ("1", "true", "yes")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_FETCH_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_PDF_PAGES = max(1, int(os.getenv("GB_MAX_PDF_PAGES", "200")))
MAX_EXTRACTED_CHARS = max(10_000, int(os.getenv("GB_MAX_EXTRACTED_CHARS", "2000000")))
MAX_JSON_BODY_BYTES = max(64 * 1024, int(os.getenv("GB_MAX_JSON_BODY_BYTES", "2500000")))
MAX_MULTIPART_BODY_BYTES = max(64 * 1024, int(os.getenv("GB_MAX_MULTIPART_BODY_BYTES", "11534336")))
MAX_BODY_CHUNKS = 1024
SQLITE_BUSY_TIMEOUT_MS = max(0, int(os.getenv("GB_SQLITE_BUSY_TIMEOUT_MS", "5000")))
RATE_LIMIT_PER_MIN = max(1, int(os.getenv("GB_API_RATE_LIMIT_PER_MIN", "120")))
RATE_LIMIT_WINDOW_SECONDS = 60
MAX_RATE_LIMIT_BUCKETS = max(1000, int(os.getenv("GB_API_MAX_RATE_BUCKETS", "10000")))
MAX_AUDIT_SCAN_ROWS = 5000
API_READ_ONLY = os.getenv("GB_API_READ_ONLY", "").lower() in ("1", "true", "yes", "on")

_READ_ONLY_MUTATIONS = (
    ("POST", re.compile(r"^/memories(?:/[^/]+/(?:confirm|reject))?$|^/memories/merge$")),
    ("PATCH", re.compile(r"^/memories/[^/]+$")),
    ("POST", re.compile(r"^/docs(?:/url|/file)?$")),
    ("PATCH", re.compile(r"^/docs/[^/]+$")),
    ("DELETE", re.compile(r"^/docs/[^/]+$")),
)

def _read_only_mutation(method: str, path_value: str) -> bool:
    return API_READ_ONLY and any(method == expected and pattern.match(path_value) for expected, pattern in _READ_ONLY_MUTATIONS)

_doc_index_timer = None
_doc_index_lock = threading.Lock()
_rate_limit_lock = threading.Lock()
_rate_limit_buckets = {}
_last_rate_limit_sweep = 0.0

_logging = logging.getLogger("gigabrain")
if not TOKEN:
    _logging.warning("GB_UI_TOKEN is not set — authenticated endpoints will reject all requests")

_STATIC_INDEX_PATH = os.path.join(os.path.dirname(__file__), "static", "index.html")
with open(_STATIC_INDEX_PATH, "rb") as _static_index_file:
    _STATIC_INDEX_BYTES = _static_index_file.read()
_STATIC_INDEX_HTML = _STATIC_INDEX_BYTES.decode("utf-8")


def _inline_csp_hash(tag: bytes) -> str:
    matches = re.findall(
        rb"<" + tag + rb"(?:\s[^>]*)?>(.*?)</" + tag + rb">",
        _STATIC_INDEX_BYTES,
        flags=re.DOTALL | re.IGNORECASE,
    )
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one inline {tag.decode('ascii')} block")
    digest = base64.b64encode(hashlib.sha256(matches[0]).digest()).decode("ascii")
    return f"'sha256-{digest}'"


_INLINE_SCRIPT_CSP = _inline_csp_hash(b"script")
_INLINE_STYLE_CSP = _inline_csp_hash(b"style")


def _load_gateway_token() -> str:
    for env_name in ("GB_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_TOKEN"):
        candidate = str(os.getenv(env_name, "")).strip()
        if candidate:
            return candidate
    try:
        with open(OPENCLAW_CONFIG_PATH, "r", encoding="utf-8") as fh:
            config = json.load(fh)
        return str((((config.get("gateway") or {}).get("auth") or {}).get("token")) or "").strip()
    except Exception:
        return ""


PLUGIN_PROXY_TOKEN = str(TOKEN or _load_gateway_token()).strip()

SCOPE_TOKENS = {}
_raw_scope_tokens = os.getenv("GB_UI_SCOPE_TOKENS", "").strip()
if _raw_scope_tokens:
    try:
        parsed = json.loads(_raw_scope_tokens)
        if isinstance(parsed, dict):
            SCOPE_TOKENS = {
                str(scope).strip(): str(token).strip()
                for scope, token in parsed.items()
                if str(scope).strip() and str(token).strip()
            }
    except Exception:
        _logging.warning("Invalid GB_UI_SCOPE_TOKENS JSON; ignoring scope token map")


class RequestBodyLimitMiddleware:
    def __init__(self, app, json_max_bytes: int, multipart_max_bytes: int):
        self.app = app
        self.json_max_bytes = json_max_bytes
        self.multipart_max_bytes = multipart_max_bytes

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        if _read_only_mutation(str(scope.get("method") or "").upper(), str(scope.get("path") or "")):
            response = JSONResponse(status_code=503, content={"detail": "Memory API is read-only"})
            await response(scope, receive, send)
            return

        raw_headers = [(key.lower(), value) for key, value in scope.get("headers", [])]
        headers = {key: value for key, value in raw_headers}
        content_type = headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower()
        if content_type == b"application/json" or content_type.endswith(b"+json"):
            max_bytes = self.json_max_bytes
            too_large_detail = "JSON body too large"
        elif content_type == b"multipart/form-data":
            max_bytes = self.multipart_max_bytes
            too_large_detail = "multipart body too large"
        else:
            await self.app(scope, receive, send)
            return

        content_lengths = [
            value.strip()
            for key, value in raw_headers
            if key == b"content-length"
        ]
        if len(content_lengths) > 1:
            response = JSONResponse(status_code=400, content={"detail": "ambiguous content length"})
            await response(scope, receive, send)
            return
        raw_length = content_lengths[0] if content_lengths else b""
        if raw_length:
            try:
                content_length = int(raw_length)
            except ValueError:
                response = JSONResponse(status_code=400, content={"detail": "invalid content length"})
                await response(scope, receive, send)
                return
            if content_length < 0:
                response = JSONResponse(status_code=400, content={"detail": "invalid content length"})
                await response(scope, receive, send)
                return
            if content_length > max_bytes:
                response = JSONResponse(status_code=413, content={"detail": too_large_detail})
                await response(scope, receive, send)
                return

        body = bytearray()
        chunk_count = 0
        while True:
            message = await receive()
            if message.get("type") == "http.disconnect":
                return
            if message.get("type") != "http.request":
                continue
            chunk_count += 1
            if chunk_count > MAX_BODY_CHUNKS:
                response = JSONResponse(status_code=413, content={"detail": "request body too fragmented"})
                await response(scope, receive, send)
                return
            body.extend(message.get("body", b""))
            if len(body) > max_bytes:
                response = JSONResponse(status_code=413, content={"detail": too_large_detail})
                await response(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        replayed = False

        async def replay_receive():
            nonlocal replayed
            if replayed:
                return {"type": "http.request", "body": b"", "more_body": False}
            replayed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay_receive, send)

app = FastAPI(
    title="Gigabrain Memory API",
    docs_url="/_docs" if ENABLE_API_DOCS else None,
    redoc_url="/_redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)
app.add_middleware(
    RequestBodyLimitMiddleware,
    json_max_bytes=MAX_JSON_BODY_BYTES,
    multipart_max_bytes=MAX_MULTIPART_BODY_BYTES,
)


@app.exception_handler(Exception)
async def _global_exception_handler(request: Request, exc: Exception):
    _logging.exception("Unhandled API exception on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal error"})


def _match_token(candidate: str) -> Optional[dict]:
    if not candidate:
        return None
    candidate_bytes = candidate.encode("utf-8")
    if TOKEN and hmac.compare_digest(candidate_bytes, TOKEN.encode("utf-8")):
        return {"is_admin": True, "allowed_scopes": []}
    for scope, scoped_token in SCOPE_TOKENS.items():
        if hmac.compare_digest(candidate_bytes, scoped_token.encode("utf-8")):
            return {"is_admin": False, "allowed_scopes": [scope]}
    return None


def _rate_limit_key(request: Request) -> str:
    token = str(request.headers.get("X-GB-Token", "")).strip()
    matched = _match_token(token)
    if matched is not None:
        token_digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
        return f"token:{token_digest}:{request.url.path}"

    # Invalid-token rotation must not create a fresh bucket for every attempt.
    # Hash the ASGI peer address so rate-limit state never stores raw tokens or IPs.
    client = request.client.host if request.client else "unknown"
    client_digest = hashlib.sha256(str(client).encode("utf-8")).hexdigest()[:24]
    return f"unauthenticated-client:{client_digest}"


def _prune_rate_limit_buckets(cutoff: float) -> None:
    global _last_rate_limit_sweep
    stale_keys = [
        key for key, bucket in _rate_limit_buckets.items()
        if not bucket or bucket[-1] <= cutoff
    ]
    for key in stale_keys:
        _rate_limit_buckets.pop(key, None)
    overflow = len(_rate_limit_buckets) - MAX_RATE_LIMIT_BUCKETS + 1
    if overflow > 0:
        oldest = sorted(
            _rate_limit_buckets,
            key=lambda key: _rate_limit_buckets[key][-1] if _rate_limit_buckets[key] else 0,
        )[:overflow]
        for key in oldest:
            _rate_limit_buckets.pop(key, None)
    _last_rate_limit_sweep = time.time()


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    global _last_rate_limit_sweep
    path = request.url.path
    if path.startswith("/static") or path in {"/", "/_docs", "/_redoc", "/openapi.json"}:
        return await call_next(request)

    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    key = _rate_limit_key(request)

    with _rate_limit_lock:
        if (
            now - _last_rate_limit_sweep >= RATE_LIMIT_WINDOW_SECONDS
            or len(_rate_limit_buckets) >= MAX_RATE_LIMIT_BUCKETS
        ):
            _prune_rate_limit_buckets(cutoff)
        bucket = _rate_limit_buckets.setdefault(key, deque())
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_PER_MIN:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "rate limit exceeded",
                    "retry_after_s": max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - bucket[0]))),
                },
            )
        bucket.append(now)

    return await call_next(request)


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    # This console is for local/Tailscale use; avoid stale JS/CSS after deploys.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src 'self' {_INLINE_SCRIPT_CSP}; "
        f"style-src 'self' {_INLINE_STYLE_CSP}; connect-src 'self'; img-src 'self' data:; "
        "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; "
        "form-action 'self'"
    )
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


def require_token(request: Request) -> dict:
    candidate = str(request.headers.get("X-GB-Token", "")).strip()
    if not candidate:
        raise HTTPException(status_code=401, detail="Unauthorized")

    matched = _match_token(candidate)
    if matched is not None:
        return matched

    if not TOKEN and not SCOPE_TOKENS:
        raise HTTPException(status_code=401, detail="GB_UI_TOKEN not configured")
    raise HTTPException(status_code=401, detail="Unauthorized")


def _sqlite_journal_format(db_path: str) -> str:
    try:
        with open(db_path, "rb") as database_file:
            header = database_file.read(20)
    except OSError as exc:
        raise HTTPException(status_code=503, detail="Memory API database unavailable") from exc
    if len(header) != 20 or header[:16] != b"SQLite format 3\x00":
        raise HTTPException(status_code=503, detail="Memory API database header invalid")
    versions = (header[18], header[19])
    if versions == (2, 2):
        return "wal"
    if versions == (1, 1):
        return "rollback"
    raise HTTPException(status_code=503, detail="Memory API database header unsupported")


def get_db():
    if API_READ_ONLY:
        if not os.path.exists(DB_PATH):
            raise HTTPException(status_code=503, detail="Memory API database unavailable")
        absolute_path = os.path.abspath(DB_PATH)
        wal_path = f"{absolute_path}-wal"
        shm_path = f"{absolute_path}-shm"
        wal_exists = os.path.exists(wal_path)
        shm_exists = os.path.exists(shm_path)
        journal_format = _sqlite_journal_format(absolute_path)
        if journal_format == "wal" and not (wal_exists and shm_exists):
            raise HTTPException(status_code=503, detail="Memory API WAL sidecars unavailable")
        if journal_format == "rollback" and (wal_exists or shm_exists):
            raise HTTPException(status_code=503, detail="Memory API database sidecars inconsistent")
        uri = f"file:{absolute_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=max(1.0, SQLITE_BUSY_TIMEOUT_MS / 1000.0))
    else:
        conn = sqlite3.connect(DB_PATH, timeout=max(1.0, SQLITE_BUSY_TIMEOUT_MS / 1000.0))
    conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")
    if API_READ_ONLY:
        conn.execute("PRAGMA query_only = ON")
    conn.row_factory = sqlite3.Row
    return conn


def db_connection():
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()

MEMORY_ROWSET = """
(
  SELECT
    mc.memory_id AS id, mc.type, mc.content, mc.normalized, md.concept,
    mc.source, mc.source_agent, mc.source_session, md.source_message_id,
    mc.confidence, mc.status, mc.scope, mc.tags, mc.created_at, mc.updated_at,
    md.last_injected_at, md.last_confirmed_at, md.ttl_days,
    mc.content_time, mc.valid_until, COALESCE(md.pinned, 0) AS pinned,
    mc.superseded_by, mc.value_score, mc.value_label,
    md.review_version, md.review_reason, mc.archived_at, mc.last_reviewed_at,
    mc.source_layer, mc.source_path, mc.source_line,
    mc.source_host, mc.source_kind, mc.sync_policy
  FROM memory_current mc
  LEFT JOIN memory_console_metadata md ON md.memory_id = mc.memory_id
)
"""

_projection_savepoint_counter = 0

@contextmanager
def projection_batch(conn: sqlite3.Connection, operation_id: str):
    global _projection_savepoint_counter
    operation = re.sub(r"[^A-Za-z0-9._-]", "-", str(operation_id or "memory-api"))[:128]
    outer = not conn.in_transaction
    _projection_savepoint_counter += 1
    savepoint = f"gb_api_projection_{_projection_savepoint_counter}"
    conn.execute("BEGIN IMMEDIATE" if outer else f"SAVEPOINT {savepoint}")
    try:
        yield {"operation_id": operation, "now": _iso_utc()}
        conn.execute("COMMIT" if outer else f"RELEASE {savepoint}")
    except Exception:
        if outer:
            conn.execute("ROLLBACK")
        else:
            conn.execute(f"ROLLBACK TO {savepoint}")
            conn.execute(f"RELEASE {savepoint}")
        raise

def _memory_api_row(conn: sqlite3.Connection, memory_id: str):
    return conn.execute(f"SELECT * FROM {MEMORY_ROWSET} WHERE id = ?", (memory_id,)).fetchone()

def _append_projection_event(conn, memory_id, action, operation_id, reason_codes, timestamp=None,
                             projection_mutation=None):
    conn.execute("""
        INSERT INTO memory_events (
          event_id,timestamp,component,action,reason_codes,memory_id,cleanup_version,
          run_id,review_version,similarity,matched_memory_id,agent_id,payload
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        str(uuid.uuid4()), timestamp or _iso_utc(), "memory_api", action,
        json.dumps(reason_codes), memory_id, "v0.11-compat", operation_id, "",
        None, None, "memory_api", json.dumps({
            "operation_id": operation_id,
            "projection_event_kind": "row",
            "projection_mutation": projection_mutation or action.split(":")[-1],
        }),
    ))

def _sync_legacy_from_authority(conn, memory_id):
    row = _memory_api_row(conn, memory_id)
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    values = dict(row)
    conn.execute("""
      INSERT INTO memories (
        id,type,content,normalized,concept,source,source_agent,source_session,source_message_id,
        confidence,status,scope,tags,created_at,updated_at,last_injected_at,last_confirmed_at,
        ttl_days,content_time,valid_until,pinned,superseded_by,value_score,value_label,
        review_version,review_reason,archived_at,last_reviewed_at,
        source_layer,source_path,source_line,source_host,source_kind,sync_policy
      ) VALUES (
        :id,:type,:content,:normalized,:concept,:source,:source_agent,:source_session,:source_message_id,
        :confidence,:status,:scope,:tags,:created_at,:updated_at,:last_injected_at,:last_confirmed_at,
        :ttl_days,:content_time,:valid_until,:pinned,:superseded_by,:value_score,:value_label,
        :review_version,:review_reason,:archived_at,:last_reviewed_at,
        :source_layer,:source_path,:source_line,:source_host,:source_kind,:sync_policy
      ) ON CONFLICT(id) DO UPDATE SET
        type=excluded.type,content=excluded.content,normalized=excluded.normalized,concept=excluded.concept,
        source=excluded.source,source_agent=excluded.source_agent,source_session=excluded.source_session,
        source_message_id=excluded.source_message_id,confidence=excluded.confidence,status=excluded.status,
        scope=excluded.scope,tags=excluded.tags,created_at=excluded.created_at,updated_at=excluded.updated_at,
        last_injected_at=excluded.last_injected_at,last_confirmed_at=excluded.last_confirmed_at,
        ttl_days=excluded.ttl_days,content_time=excluded.content_time,valid_until=excluded.valid_until,
        pinned=excluded.pinned,superseded_by=excluded.superseded_by,value_score=excluded.value_score,
        value_label=excluded.value_label,review_version=excluded.review_version,review_reason=excluded.review_reason,
        archived_at=excluded.archived_at,last_reviewed_at=excluded.last_reviewed_at,
        source_layer=excluded.source_layer,source_path=excluded.source_path,source_line=excluded.source_line,
        source_host=excluded.source_host,source_kind=excluded.source_kind,sync_policy=excluded.sync_policy
    """, values)
    return row

def _projection_upsert(conn, row, metadata, operation_id, *, now=None,
                       event_action="projection:upsert", projection_mutation="upsert",
                       reason_codes=None):
    existing = conn.execute(
        "SELECT * FROM memory_current WHERE memory_id=?",
        (str(row.get("memory_id") or row.get("id") or "").strip(),),
    ).fetchone()
    row = _canonical_current_row(row, dict(existing) if existing else None, now)
    metadata = _canonical_console_metadata(metadata)
    conn.execute("""
      INSERT INTO memory_current (
        memory_id,type,content,normalized,normalized_hash,source,source_agent,source_session,
        source_layer,source_path,source_line,source_host,source_kind,sync_policy,confidence,
        scope,status,value_score,value_label,created_at,updated_at,archived_at,last_reviewed_at,
        tags,superseded_by,content_time,valid_until,valid_from
      ) VALUES (
        :memory_id,:type,:content,:normalized,:normalized_hash,:source,:source_agent,:source_session,
        :source_layer,:source_path,:source_line,:source_host,:source_kind,:sync_policy,:confidence,
        :scope,:status,:value_score,:value_label,:created_at,:updated_at,:archived_at,:last_reviewed_at,
        :tags,:superseded_by,:content_time,:valid_until,:valid_from
      ) ON CONFLICT(memory_id) DO UPDATE SET
        type=excluded.type,content=excluded.content,normalized=excluded.normalized,
        normalized_hash=excluded.normalized_hash,source=excluded.source,source_agent=excluded.source_agent,
        source_session=excluded.source_session,source_layer=excluded.source_layer,source_path=excluded.source_path,
        source_line=excluded.source_line,source_host=excluded.source_host,source_kind=excluded.source_kind,
        sync_policy=excluded.sync_policy,confidence=excluded.confidence,scope=excluded.scope,status=excluded.status,
        value_score=excluded.value_score,value_label=excluded.value_label,updated_at=excluded.updated_at,
        archived_at=excluded.archived_at,last_reviewed_at=excluded.last_reviewed_at,tags=excluded.tags,
        superseded_by=excluded.superseded_by,content_time=excluded.content_time,
        valid_until=excluded.valid_until,valid_from=excluded.valid_from
    """, row)
    conn.execute("INSERT OR IGNORE INTO memory_console_metadata (memory_id,pinned) VALUES (?,0)", (row["memory_id"],))
    if metadata:
        allowed = ("concept","source_message_id","last_injected_at","last_confirmed_at","ttl_days","pinned","review_version","review_reason")
        keys = [key for key in allowed if key in metadata]
        if keys:
            conn.execute(f"UPDATE memory_console_metadata SET {','.join(f'{key}=?' for key in keys)} WHERE memory_id=?",
                         [1 if key == "pinned" and metadata[key] else metadata[key] for key in keys] + [row["memory_id"]])
    _sync_legacy_from_authority(conn, row["memory_id"])
    _append_projection_event(
        conn,
        row["memory_id"],
        event_action,
        operation_id,
        reason_codes or [projection_mutation],
        row["updated_at"],
        projection_mutation,
    )
    return _memory_api_row(conn, row["memory_id"])

def _projection_status(conn, memory_id, status, operation_id, *, superseded_by=None, clear_superseded=False,
                       metadata=None, timestamp=None, event_action="projection:status"):
    now = _canonical_optional_iso(timestamp) or _iso_utc()
    existing = conn.execute("SELECT * FROM memory_current WHERE memory_id=?", (memory_id,)).fetchone()
    if not existing:
        return 0
    existing = dict(existing)
    target_status = _canonical_status(status)
    desired = {
        **existing,
        "archived_at": now if target_status == "archived" else None,
        "last_reviewed_at": now,
        "status": target_status,
        "superseded_by": None if clear_superseded else (
            str(superseded_by) if superseded_by else existing.get("superseded_by")
        ),
        "updated_at": now,
    }
    _projection_upsert(
        conn,
        desired,
        metadata or {},
        operation_id,
        now=now,
        event_action=event_action,
        projection_mutation="status",
        reason_codes=[target_status],
    )
    return 1


def _is_admin(auth: dict) -> bool:
    return bool(auth and auth.get("is_admin"))


def _allowed_scopes(auth: dict) -> set[str]:
    return {
        str(scope).strip()
        for scope in (auth or {}).get("allowed_scopes", [])
        if str(scope).strip()
    }


def _apply_scope_filter(clauses: list[str], params: list[Any], scope: Optional[str], auth: dict) -> None:
    requested = (scope or "").strip()
    if _is_admin(auth):
        if requested:
            if requested.endswith("*"):
                clauses.append("scope LIKE ?")
                params.append(requested[:-1] + "%")
            else:
                clauses.append("scope = ?")
                params.append(requested)
        return

    allowed = _allowed_scopes(auth)
    if not allowed:
        raise HTTPException(status_code=403, detail="No scope access")
    if requested:
        if requested.endswith("*"):
            raise HTTPException(status_code=403, detail="Wildcard scope not allowed")
        if requested not in allowed:
            raise HTTPException(status_code=403, detail="Scope forbidden")
        clauses.append("scope = ?")
        params.append(requested)
        return
    if len(allowed) == 1:
        only_scope = next(iter(allowed))
        clauses.append("scope = ?")
        params.append(only_scope)
        return
    placeholders = ",".join("?" for _ in sorted(allowed))
    clauses.append(f"scope IN ({placeholders})")
    params.extend(sorted(allowed))


def _ensure_scope_allowed(scope: str, auth: dict) -> None:
    if _is_admin(auth):
        return
    allowed = _allowed_scopes(auth)
    if scope not in allowed:
        raise HTTPException(status_code=403, detail="Scope forbidden")


def _resolve_single_scope(scope: Optional[str], auth: dict) -> str:
    requested = (scope or "").strip()
    if _is_admin(auth):
        return requested
    allowed = _allowed_scopes(auth)
    if not allowed:
        raise HTTPException(status_code=403, detail="No scope access")
    if requested:
        if requested.endswith("*"):
            raise HTTPException(status_code=403, detail="Wildcard scope not allowed")
        if requested not in allowed:
            raise HTTPException(status_code=403, detail="Scope forbidden")
        return requested
    if len(allowed) == 1:
        return next(iter(allowed))
    raise HTTPException(status_code=400, detail="Explicit scope required")


def _ensure_doc_access(auth: dict) -> None:
    if _is_admin(auth):
        return
    raise HTTPException(status_code=403, detail="Document endpoints require admin token")


def _memory_scope_or_404(conn: sqlite3.Connection, memory_id: str, auth: dict) -> str:
    row = conn.execute("SELECT scope FROM memory_current WHERE memory_id = ?", (memory_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    scope = str(row["scope"] or "shared")
    if not _is_admin(auth) and scope not in _allowed_scopes(auth):
        # Do not disclose whether an identifier exists outside the caller's scope.
        raise HTTPException(status_code=404, detail="Not found")
    return scope


def _memory_scope(conn: sqlite3.Connection, memory_id: str) -> Optional[str]:
    row = conn.execute("SELECT scope FROM memory_current WHERE memory_id = ?", (memory_id,)).fetchone()
    if not row:
        return None
    return str(row["scope"] or "shared")


def _memory_is_accessible(conn: sqlite3.Connection, memory_id: str, auth: dict) -> bool:
    scope = _memory_scope(conn, memory_id)
    if scope is None:
        return False
    if _is_admin(auth):
        return True
    return scope in _allowed_scopes(auth)


def _filter_relation_rows(conn: sqlite3.Connection, rows: list[sqlite3.Row], auth: dict) -> list[dict]:
    out: list[dict] = []
    for row in rows or []:
        from_memory_id = str(row["from_memory_id"] or "")
        to_memory_id = str(row["to_memory_id"] or "")
        if not _memory_is_accessible(conn, from_memory_id, auth):
            continue
        if not _memory_is_accessible(conn, to_memory_id, auth):
            continue
        out.append(dict(row))
    return out


def _escape_like(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _contains_like(value: str) -> str:
    return f"%{_escape_like(value)}%"


def _tag_like(tag: str) -> str:
    return f"%\"{_escape_like(tag)}\"%"


def _is_within_docs_dir(file_path: str) -> bool:
    if not file_path:
        return False
    try:
        docs_root = os.path.realpath(DOCS_DIR)
        target = os.path.realpath(file_path)
        return os.path.commonpath([docs_root, target]) == docs_root
    except Exception:
        return False


def _has_table(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (str(table_name or ""),),
    ).fetchone()
    return bool(row and row["name"])


def _require_admin_world(auth: dict) -> None:
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="World-model endpoints require admin token")


def _default_surface_summary() -> dict:
    return {
        "generated_at": None,
        "active_nodes": 0,
        "source_files": 0,
        "counts": {
            "by_status": {},
            "by_type": [],
            "by_scope": [],
            "by_source_layer": {},
        },
        "native_sources": {
            "total": 0,
            "last_source_at": None,
            "last_daily_note_at": None,
            "items": [],
        },
        "review_queue": {
            "total": 0,
            "pending": 0,
            "items": [],
        },
        "recent_archives": {
            "count": 0,
            "items": [],
        },
        "freshness": {
            "native": {
                "last_source_at": None,
                "last_daily_note_at": None,
                "stale": True,
                "daily_note_stale": True,
            },
            "vault": {
                "last_built_at": None,
                "stale": True,
            },
            "manual_protection": {
                "ok": True,
                "issues": [],
            },
        },
        "reports": {
            "latest_nightly": {
                "source_path": "",
            },
            "latest_native_sync": {
                "source_path": "",
            },
        },
        "surface_summary_path": SURFACE_SUMMARY_PATH,
    }


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


BoundedMemoryId = Annotated[str, Field(min_length=1, max_length=128)]
BoundedTag = Annotated[str, Field(min_length=1, max_length=128)]


class MemoryCreatePayload(StrictModel):
    id: Optional[BoundedMemoryId] = None
    content: str = Field(min_length=1, max_length=20_000)
    type: str = Field(default="CONTEXT", min_length=1, max_length=64)
    source: str = Field(default="user", min_length=1, max_length=64)
    source_agent: Optional[str] = Field(default="ui", max_length=256)
    source_session: Optional[str] = Field(default="ui", max_length=256)
    source_message_id: Optional[str] = Field(default=None, max_length=256)
    concept: Optional[str] = Field(default=None, max_length=512)
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    status: str = Field(default="active", min_length=1, max_length=64)
    scope: str = Field(default="shared", min_length=1, max_length=255)
    tags: list[BoundedTag] = Field(default_factory=list, max_length=100)
    last_confirmed_at: Optional[str] = None
    ttl_days: Optional[int] = Field(default=None, ge=1, le=3650)
    content_time: Optional[str] = None
    valid_until: Optional[str] = None
    pinned: bool = False
    review_version: Optional[str] = Field(default=None, max_length=256)
    review_reason: Optional[str] = Field(default=None, max_length=512)
    superseded_by: Optional[str] = Field(default=None, max_length=128)


class MemoryUpdatePayload(StrictModel):
    content: Optional[str] = Field(default=None, min_length=1, max_length=20_000)
    type: Optional[str] = Field(default=None, min_length=1, max_length=64)
    status: Optional[str] = Field(default=None, min_length=1, max_length=64)
    ttl_days: Optional[int] = Field(default=None, ge=1, le=3650)
    content_time: Optional[str] = None
    valid_until: Optional[str] = None
    pinned: Optional[bool] = None
    superseded_by: Optional[str] = Field(default=None, max_length=128)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    tags: Optional[list[BoundedTag]] = Field(default=None, max_length=100)
    concept: Optional[str] = Field(default=None, max_length=512)
    source_message_id: Optional[str] = Field(default=None, max_length=256)
    last_injected_at: Optional[str] = None
    last_confirmed_at: Optional[str] = None
    review_version: Optional[str] = Field(default=None, max_length=256)
    review_reason: Optional[str] = Field(default=None, max_length=512)


class DocCreatePayload(StrictModel):
    id: Optional[BoundedMemoryId] = None
    title: Optional[str] = Field(default=None, max_length=1000)
    source: Optional[str] = Field(default=None, max_length=256)
    url: Optional[str] = Field(default=None, max_length=2048)
    tags: list[BoundedTag] = Field(default_factory=list, max_length=100)
    content: str = Field(min_length=1, max_length=2_000_000)
    status: str = Field(default="active", min_length=1, max_length=64)


class DocFromUrlPayload(StrictModel):
    url: str = Field(min_length=1, max_length=2048)
    tags: list[BoundedTag] = Field(default_factory=list, max_length=100)


class DocUpdatePayload(StrictModel):
    title: Optional[str] = Field(default=None, max_length=1000)
    source: Optional[str] = Field(default=None, max_length=256)
    url: Optional[str] = Field(default=None, max_length=2048)
    tags: Optional[list[BoundedTag]] = Field(default=None, max_length=100)
    status: Optional[str] = Field(default=None, min_length=1, max_length=64)
    content: Optional[str] = Field(default=None, min_length=1, max_length=2_000_000)


class MergeMemoriesPayload(StrictModel):
    ids: list[BoundedMemoryId] = Field(min_length=2, max_length=100)


class RecallExplainPayload(StrictModel):
    query: str = Field(min_length=1, max_length=1000)
    scope: Optional[str] = Field(default=None, max_length=255)


def normalize_content(content: str) -> str:
    if not content:
        return ""
    normalized = content.lower()
    normalized = re.sub(r"\[m:[0-9a-f-]{8,}\]", "", normalized)
    normalized = "".join(char if (char.isalnum() or char.isspace()) else " " for char in normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized

def normalized_hash(content: str) -> str:
    return hashlib.sha256(normalize_content(content).encode("utf-8")).hexdigest()


def _iso_utc(value: Optional[datetime] = None) -> str:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(value: str) -> Optional[datetime]:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    # The legacy API emitted both `...Z` and `...+00:00Z`. Strip only the
    # trailing marker, then normalize every parsed value to aware UTC.
    if raw[-1:].lower() == "z":
        raw = raw[:-1]
    try:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _canonical_iso_text(value: Optional[str]) -> Optional[str]:
    return _canonical_optional_iso(value)


_SCOPE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_CANONICAL_STATUSES = {"active", "archived", "pending", "rejected", "superseded"}
_CONSOLE_METADATA_FIELDS = {
    "concept", "source_message_id", "last_injected_at", "last_confirmed_at",
    "ttl_days", "pinned", "review_version", "review_reason",
}


def _canonical_datetime(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw[-1:].lower() == "z":
        raw = f"{raw[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _canonical_optional_iso(value: Any) -> Optional[str]:
    parsed = _canonical_datetime(value)
    return _iso_utc(parsed) if parsed is not None else None


def _canonical_content_time(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    return _canonical_optional_iso(raw)


def _canonical_status(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in _CANONICAL_STATUSES else "active"


def _normalize_projection_scope(value: Any = "", *, allow_empty: bool = False,
                                fallback: str = "shared") -> str:
    raw = str(value or "").strip()
    if not raw:
        return "" if allow_empty else str(fallback or "shared")
    lowered = raw.lower()
    if lowered == "default":
        return "shared"
    if lowered in {"shared", "main"}:
        return lowered
    segments = raw.split(":")
    if len(segments) == 1 and _SCOPE_SEGMENT_RE.fullmatch(raw):
        return raw
    if len(segments) < 2 or not all(_SCOPE_SEGMENT_RE.fullmatch(segment or "") for segment in segments):
        raise HTTPException(status_code=422, detail=f"Invalid Gigabrain scope: {raw}")
    return raw


def _finite_number(value: Any, fallback: Optional[float]) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _canonical_console_metadata(metadata: Optional[dict]) -> dict:
    output = {}
    for field, value in (metadata or {}).items():
        if field not in _CONSOLE_METADATA_FIELDS:
            continue
        if field == "pinned":
            output[field] = 1 if value is True or _finite_number(value, None) == 1 else 0
        elif field == "ttl_days":
            number = _finite_number(value, None)
            output[field] = max(0, math.trunc(number)) if number is not None else None
        elif field in {"last_injected_at", "last_confirmed_at"}:
            output[field] = _canonical_optional_iso(value)
        else:
            output[field] = None if value is None or value == "" else str(value)
    return output


def _canonical_current_row(memory: dict, existing: Optional[dict] = None,
                           now: Optional[str] = None) -> dict:
    now_iso = _canonical_optional_iso(now) or _iso_utc()
    memory_id = str(memory.get("memory_id") or memory.get("id") or "").strip()
    if not memory_id:
        raise HTTPException(status_code=422, detail="memory_id is required")
    content = str(memory.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=422, detail="content is required")
    normalized = normalize_content(content)
    content_time = _canonical_content_time(memory.get("content_time"))
    content_datetime = _canonical_datetime(content_time)
    now_datetime = _canonical_datetime(now_iso)
    if content_datetime and now_datetime and content_datetime > now_datetime:
        content_time = now_iso
    created_at = (
        existing.get("created_at")
        if existing is not None
        else (_canonical_optional_iso(memory.get("created_at")) or now_iso)
    )
    explicit_valid_from = _canonical_optional_iso(memory.get("valid_from"))
    if explicit_valid_from is None and content_time:
        explicit_valid_from = _canonical_optional_iso(content_time)

    source_line = None
    raw_source_line = memory.get("source_line")
    if raw_source_line is not None and raw_source_line != "":
        parsed_source_line = _finite_number(raw_source_line, None)
        if parsed_source_line is not None:
            source_line = max(1, math.trunc(parsed_source_line))

    raw_tags = memory.get("tags")
    if isinstance(raw_tags, list):
        tags = json.dumps(raw_tags, ensure_ascii=False, separators=(",", ":"))
    else:
        tags = str(raw_tags) if raw_tags else "[]"

    return {
        "memory_id": memory_id,
        "type": str(memory.get("type") or "CONTEXT").strip().upper() or "CONTEXT",
        "content": content,
        "normalized": normalized,
        "normalized_hash": normalized_hash(normalized) if normalized else "",
        "source": str(memory.get("source") or "capture"),
        "source_agent": str(memory["source_agent"]) if memory.get("source_agent") else None,
        "source_session": str(memory["source_session"]) if memory.get("source_session") else None,
        "source_layer": str(memory.get("source_layer") or "registry"),
        "source_path": str(memory["source_path"]) if memory.get("source_path") else None,
        "source_line": source_line,
        "source_host": str(memory.get("source_host") or "gigabrain"),
        "source_kind": str(memory.get("source_kind") or "registry"),
        "sync_policy": str(memory.get("sync_policy") or "read_only"),
        "confidence": _finite_number(memory.get("confidence"), 0.6),
        "scope": _normalize_projection_scope(memory.get("scope") or "shared"),
        "status": _canonical_status(memory.get("status") or "active"),
        "value_score": _finite_number(memory.get("value_score"), None),
        "value_label": str(memory["value_label"]) if memory.get("value_label") else None,
        "created_at": created_at,
        "updated_at": _canonical_optional_iso(memory.get("updated_at")) or now_iso,
        "archived_at": _canonical_optional_iso(memory.get("archived_at")),
        "last_reviewed_at": _canonical_optional_iso(memory.get("last_reviewed_at")),
        "tags": tags,
        "superseded_by": str(memory["superseded_by"]) if memory.get("superseded_by") else None,
        "content_time": content_time,
        "valid_until": _canonical_optional_iso(memory.get("valid_until")),
        "valid_from": (
            explicit_valid_from
            or (existing.get("valid_from") if existing else None)
            or created_at
            or now_iso
        ),
    }


def _is_expired(row: dict, now: datetime) -> bool:
    try:
        valid_until = _parse_iso(row.get("valid_until") or "")
        if valid_until and valid_until < now:
            return True
    except Exception:
        pass
    try:
        ttl_days = row.get("ttl_days")
        if ttl_days is None:
            return False
        created_at = _parse_iso(row.get("created_at") or "")
        if not created_at:
            return False
        until = created_at + timedelta(days=int(ttl_days))
        return until < now
    except Exception:
        return False


def ensure_docs_dir():
    if API_READ_ONLY:
        return
    os.makedirs(DOCS_DIR, exist_ok=True)
    os.makedirs(os.path.join(DOCS_DIR, "raw"), exist_ok=True)


def ensure_storage_dirs():
    if API_READ_ONLY:
        return
    if DB_PATH != ":memory:":
        db_parent = os.path.dirname(os.path.abspath(DB_PATH))
        if db_parent:
            os.makedirs(db_parent, exist_ok=True)
    for target in (DOC_INDEX_LOCK_PATH, SURFACE_SUMMARY_PATH):
        parent = os.path.dirname(os.path.abspath(target))
        if parent:
            os.makedirs(parent, exist_ok=True)
    ensure_docs_dir()


def sanitize_title(title: str) -> str:
    title = (title or "").strip()
    title = re.sub(r"\s+", " ", title)
    return title[:200] if title else "Untitled document"


def strip_front_matter(text: str) -> str:
    return re.sub(r"^---[\s\S]*?---\s*", "", text).strip()


def _host_is_private(hostname: str) -> bool:
    if not hostname:
        return True
    host = hostname.lower()
    if host in ("localhost", "0.0.0.0"):
        return True
    if host.endswith(".local") or host.endswith(".internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        # Not a raw IP, resolve DNS
        try:
            for info in socket.getaddrinfo(host, None):
                addr = info[4][0]
                ip = ipaddress.ip_address(addr)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                    return True
        except Exception:
            return True
    return False


def is_public_http_url(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.username or parsed.password or not parsed.hostname or parsed.fragment:
        return False
    try:
        expected_port = 443 if parsed.scheme == "https" else 80
        if parsed.port not in (None, expected_port):
            return False
    except ValueError:
        return False
    return not _host_is_private(parsed.hostname)


def _is_loopback_http_url(url: str) -> bool:
    """Allow the recall-explain token proxy to reach loopback services only."""
    if not url:
        return False
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.username or parsed.password or not parsed.hostname:
        return False
    try:
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            return False
    except ValueError:
        return False
    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _url_import_host(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        return ""
    if parsed.fragment:
        return ""
    try:
        expected_port = 443 if parsed.scheme == "https" else 80
        if parsed.port not in (None, expected_port):
            return ""
    except ValueError:
        return ""
    try:
        return (parsed.hostname or "").encode("idna").decode("ascii").lower().rstrip(".")
    except Exception:
        return ""


def _address_is_private(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    # `is_global` fails closed for loopback, private, link-local, reserved,
    # multicast, unspecified and other special-use ranges.
    return not ip.is_global


def _resolve_url_import_target(url: str, allow_private: bool = False) -> tuple[Any, str, str, int]:
    parsed = urlparse(url)
    host = _url_import_host(url)
    if not host:
        raise HTTPException(status_code=400, detail="invalid URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise HTTPException(status_code=400, detail="URL host could not be resolved")
    addresses = []
    for info in infos:
        address = str(info[4][0])
        if address not in addresses:
            addresses.append(address)
    if not allow_private:
        addresses = [address for address in addresses if not _address_is_private(address)]
    if not addresses:
        raise HTTPException(status_code=400, detail="private or unresolved URL blocked")
    # The chosen address is carried into the socket connection. DNS is not
    # resolved a second time, closing the pre-check/request rebinding window.
    return parsed, host, addresses[0], port


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, connect_host: str, port: int, timeout: float):
        super().__init__(host, port=port, timeout=timeout, context=ssl.create_default_context())
        self._connect_host = connect_host

    def connect(self):
        if self._tunnel_host:
            raise OSError("proxy tunneling is disabled for URL import")
        raw_socket = socket.create_connection(
            (self._connect_host, self.port),
            self.timeout,
            self.source_address,
        )
        try:
            self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)
        except Exception:
            raw_socket.close()
            raise


def _fetch_url_import(url: str, allow_private: bool = False) -> tuple[str, str]:
    parsed, host, connect_host, port = _resolve_url_import_target(url, allow_private=allow_private)
    connection: Any
    if parsed.scheme == "https":
        connection = _PinnedHTTPSConnection(host, connect_host, port, timeout=5.0)
    else:
        connection = http.client.HTTPConnection(connect_host, port=port, timeout=5.0)
    host_header = f"[{host}]" if ":" in host else host
    request_target = parsed.path or "/"
    if parsed.query:
        request_target = f"{request_target}?{parsed.query}"
    try:
        connection.request(
            "GET",
            request_target,
            headers={
                "Host": host_header,
                "User-Agent": "Gigabrain/1.0",
                "Accept": "text/html,application/xhtml+xml,text/plain",
                "Accept-Encoding": "identity",
                "Connection": "close",
            },
        )
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            raise HTTPException(status_code=400, detail="URL returned a non-success response")
        content_type = str(response.getheader("content-type") or "").split(";", 1)[0].strip().lower()
        if content_type and content_type not in {"text/html", "text/plain", "application/xhtml+xml"}:
            raise HTTPException(status_code=415, detail="URL did not return HTML or plain text")
        raw_length = response.getheader("content-length")
        if raw_length:
            try:
                declared_length = int(raw_length)
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid URL response length")
            if declared_length < 0:
                raise HTTPException(status_code=400, detail="invalid URL response length")
            if declared_length > MAX_FETCH_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Fetched content too large (max {MAX_FETCH_BYTES // (1024*1024)} MB)",
                )
        chunks = []
        fetched_bytes = 0
        while True:
            chunk = response.read(min(64 * 1024, MAX_FETCH_BYTES + 1 - fetched_bytes))
            if not chunk:
                break
            fetched_bytes += len(chunk)
            if fetched_bytes > MAX_FETCH_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Fetched content too large (max {MAX_FETCH_BYTES // (1024*1024)} MB)",
                )
            chunks.append(chunk)
        raw = b"".join(chunks)
        charset = response.headers.get_content_charset() or "utf-8"
        html = raw.decode(charset, errors="replace")
        return extract_text_from_html(html)
    finally:
        connection.close()


def _safe_doc_filename(doc_id: str) -> str:
    normalized = str(doc_id or "").strip()
    if not normalized or len(normalized) > 255:
        raise HTTPException(status_code=400, detail="invalid document id")
    # The identifier is data, never a pathname. A fixed-size digest avoids both
    # traversal and sanitizer collisions such as `a/b` versus `ab`.
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _yaml_scalar(value: Optional[str]) -> str:
    normalized = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    return json.dumps(normalized, ensure_ascii=False)


def write_doc_file(
    doc_id: str,
    title: str,
    source: str,
    url: str,
    tags: list,
    content: str,
    created_at: str,
    existing_path: Optional[str] = None,
) -> str:
    ensure_docs_dir()
    doc_uuid = _safe_doc_filename(doc_id)
    docs_root = os.path.realpath(DOCS_DIR)
    legacy_path = os.path.realpath(existing_path) if existing_path and _is_within_docs_dir(existing_path) else ""
    file_path = legacy_path or os.path.join(docs_root, f"{doc_uuid}.md")
    if os.path.commonpath([docs_root, os.path.realpath(file_path)]) != docs_root:
        raise HTTPException(status_code=400, detail="invalid document path")
    front_matter = [
        "---",
        f"id: {_yaml_scalar(doc_id)}",
        f"title: {sanitize_title(title)}",
        f"source: {_yaml_scalar(source)}",
        f"url: {_yaml_scalar(url)}",
        f"tags: {json.dumps(tags or [])}",
        f"created_at: {created_at}",
        "---",
        "",
    ]
    body = (content or "").strip()
    payload = "\n".join(front_matter) + body + "\n"
    fd, temporary_path = tempfile.mkstemp(prefix=".gigabrain-doc-", suffix=".tmp", dir=docs_root, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, file_path)
        os.chmod(file_path, 0o600)
    except Exception:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise
    return file_path


def read_doc_content(file_path: str) -> str:
    if not file_path or not _is_within_docs_dir(file_path) or not os.path.exists(file_path):
        return ""
    with open(file_path, "r", encoding="utf-8") as f:
        return f.read()


def preview_doc_content(file_path: str, limit: int = 240) -> str:
    raw = read_doc_content(file_path)
    raw = strip_front_matter(raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:limit]


def extract_text_from_html(html: str) -> tuple[str, str]:
    title = ""
    content = ""
    try:
        doc = Document(html)
        title = doc.short_title() or ""
        summary_html = doc.summary() or ""
        soup = BeautifulSoup(summary_html, "lxml")
        content = soup.get_text("\n")
    except Exception:
        soup = BeautifulSoup(html, "lxml")
        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        content = soup.get_text("\n")
    return sanitize_title(title), content.strip()


def extract_text_from_pdf(data: bytes) -> str:
    reader = PdfReader(BytesIO(data))
    if len(reader.pages) > MAX_PDF_PAGES:
        raise HTTPException(status_code=413, detail=f"PDF has too many pages (max {MAX_PDF_PAGES})")
    pages = []
    extracted_chars = 0
    for page in reader.pages:
        page_text = page.extract_text() or ""
        extracted_chars += len(page_text)
        if extracted_chars > MAX_EXTRACTED_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"Extracted document text too large (max {MAX_EXTRACTED_CHARS} characters)",
            )
        pages.append(page_text)
    return "\n".join(pages).strip()


def _doc_index_lock_recent(max_age_seconds: int = 1800) -> bool:
    if not os.path.exists(DOC_INDEX_LOCK_PATH):
        return False
    try:
        age = time.time() - os.path.getmtime(DOC_INDEX_LOCK_PATH)
        return age < max_age_seconds
    except Exception:
        return True


def run_doc_index():
    if API_READ_ONLY:
        return
    if _doc_index_lock_recent():
        return
    try:
        with open(DOC_INDEX_LOCK_PATH, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
        cmd = ["openclaw", "memory", "index", "--agent", DOC_INDEX_AGENT, "--force"]
        result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=DOC_INDEX_TIMEOUT_SECONDS)
        if result.returncode == 0:
            conn = get_db()
            try:
                now = _iso_utc()
                conn.execute("UPDATE documents SET last_indexed_at = ? WHERE status != 'deleted'", (now,))
                conn.commit()
            finally:
                conn.close()
    finally:
        try:
            os.remove(DOC_INDEX_LOCK_PATH)
        except Exception:
            pass


def schedule_doc_index():
    if API_READ_ONLY:
        return
    global _doc_index_timer
    with _doc_index_lock:
        if _doc_index_timer:
            _doc_index_timer.cancel()
        _doc_index_timer = threading.Timer(DOC_INDEX_DEBOUNCE_SECONDS, run_doc_index)
        _doc_index_timer.daemon = True
        _doc_index_timer.start()


def init_db():
    if API_READ_ONLY:
        return
    ensure_storage_dirs()
    conn = get_db()
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS memory_current (
            memory_id TEXT PRIMARY KEY,
            type TEXT NOT NULL DEFAULT 'CONTEXT', content TEXT NOT NULL,
            normalized TEXT NOT NULL DEFAULT '', normalized_hash TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'capture', source_agent TEXT, source_session TEXT,
            source_layer TEXT NOT NULL DEFAULT 'registry', source_path TEXT, source_line INTEGER,
            source_host TEXT NOT NULL DEFAULT 'gigabrain', source_kind TEXT NOT NULL DEFAULT 'registry',
            sync_policy TEXT NOT NULL DEFAULT 'read_only', confidence REAL DEFAULT 0.6,
            scope TEXT NOT NULL DEFAULT 'shared', status TEXT NOT NULL DEFAULT 'active',
            value_score REAL, value_label TEXT, created_at TEXT, updated_at TEXT,
            archived_at TEXT, last_reviewed_at TEXT, tags TEXT, superseded_by TEXT,
            content_time TEXT, valid_until TEXT, valid_from TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope ON memory_current(status, scope);
        CREATE INDEX IF NOT EXISTS idx_memory_current_norm_scope ON memory_current(normalized_hash, scope, status);
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            normalized TEXT NOT NULL,
            concept TEXT,
            source TEXT NOT NULL,
            source_agent TEXT,
            source_session TEXT,
            source_message_id TEXT,
            confidence REAL,
            status TEXT,
            scope TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_injected_at TEXT,
            last_confirmed_at TEXT,
            ttl_days INTEGER,
            content_time TEXT,
            valid_until TEXT,
            pinned INTEGER DEFAULT 0,
            superseded_by TEXT,
            value_score REAL, value_label TEXT, review_version TEXT, review_reason TEXT,
            archived_at TEXT, last_reviewed_at TEXT,
            source_layer TEXT NOT NULL DEFAULT 'registry', source_path TEXT, source_line INTEGER,
            source_host TEXT NOT NULL DEFAULT 'gigabrain', source_kind TEXT NOT NULL DEFAULT 'registry',
            sync_policy TEXT NOT NULL DEFAULT 'read_only'
        );
        CREATE INDEX IF NOT EXISTS idx_memories_normalized ON memories(normalized, type);
        CREATE INDEX IF NOT EXISTS idx_memories_scope_normalized ON memories(scope, normalized);
        CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
        CREATE INDEX IF NOT EXISTS idx_memories_scope_created ON memories(scope, created_at);
        CREATE TABLE IF NOT EXISTS memory_console_metadata (
            memory_id TEXT PRIMARY KEY,
            concept TEXT, source_message_id TEXT, last_injected_at TEXT, last_confirmed_at TEXT,
            ttl_days INTEGER CHECK (ttl_days IS NULL OR ttl_days >= 0),
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            review_version TEXT, review_reason TEXT,
            FOREIGN KEY (memory_id) REFERENCES memory_current(memory_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_memory_console_metadata_concept_pinned
            ON memory_console_metadata(concept, pinned, memory_id);
        CREATE TABLE IF NOT EXISTS memory_events (
            event_id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, component TEXT NOT NULL,
            action TEXT NOT NULL, reason_codes TEXT NOT NULL DEFAULT '[]', memory_id TEXT NOT NULL,
            cleanup_version TEXT NOT NULL, run_id TEXT NOT NULL, review_version TEXT NOT NULL,
            similarity REAL, matched_memory_id TEXT, agent_id TEXT, payload TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_events_memory_ts ON memory_events(memory_id, timestamp);
        CREATE TABLE IF NOT EXISTS memory_relations (
            id TEXT PRIMARY KEY,
            from_memory_id TEXT NOT NULL,
            to_memory_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            created_at TEXT,
            source TEXT,
            confidence REAL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations(from_memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations(to_memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);
        CREATE TABLE IF NOT EXISTS evidence (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id TEXT,
            text_snippet TEXT,
            created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_memory_id ON evidence(memory_id);
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            title TEXT,
            source TEXT,
            url TEXT,
            path TEXT,
            status TEXT,
            tags TEXT,
            created_at TEXT,
            updated_at TEXT,
            last_indexed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
        CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
        """
    )
    # Existing deployed registries retain the original table and values. SQLite's
    # CREATE TABLE IF NOT EXISTS does not add later compatibility columns, so add
    # only the missing columns before the first current->legacy projection write.
    legacy_columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info(memories)")}
    legacy_additions = (
        ("concept", "TEXT"),
        ("content_time", "TEXT"),
        ("valid_until", "TEXT"),
        ("value_score", "REAL"),
        ("value_label", "TEXT"),
        ("review_version", "TEXT"),
        ("review_reason", "TEXT"),
        ("archived_at", "TEXT"),
        ("last_reviewed_at", "TEXT"),
        ("source_layer", "TEXT NOT NULL DEFAULT 'registry'"),
        ("source_path", "TEXT"),
        ("source_line", "INTEGER"),
        ("source_host", "TEXT NOT NULL DEFAULT 'gigabrain'"),
        ("source_kind", "TEXT NOT NULL DEFAULT 'registry'"),
        ("sync_policy", "TEXT NOT NULL DEFAULT 'read_only'"),
    )
    for column_name, definition in legacy_additions:
        if column_name not in legacy_columns:
            conn.execute(f"ALTER TABLE memories ADD COLUMN {column_name} {definition}")
            legacy_columns.add(column_name)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_scope_concept ON memories(scope, concept)")

    conn.commit()
    conn.close()


@asynccontextmanager
async def lifespan(app):
    if not API_READ_ONLY:
        ensure_storage_dirs()
        init_db()
    yield

app.router.lifespan_context = lifespan


@app.get("/", response_class=HTMLResponse)
def index(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return _STATIC_INDEX_HTML


app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")


@app.get("/memories")
def list_memories(
    query: Optional[str] = None,
    type: Optional[str] = None,
    status: Optional[str] = None,
    scope: Optional[str] = None,
    normalized: Optional[str] = None,
    concept: Optional[str] = None,
    tag: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    auth: dict = Depends(require_token),
):
    clauses = []
    params = []

    if query:
        clauses.append("(content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if type:
        clauses.append("type = ?")
        params.append(type)
    if status:
        clauses.append("status = ?")
        params.append(status)
    _apply_scope_filter(clauses, params, scope, auth)
    if normalized:
        clauses.append("normalized = ?")
        params.append(normalized.strip())
    if concept:
        clauses.append("COALESCE(concept, normalized) = ?")
        params.append(concept.strip())
    if tag:
        clauses.append("tags LIKE ? ESCAPE '\\'")
        params.append(_tag_like(tag))

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sort_key = (sort or "recent").lower()
    if sort_key in ("confidence", "conf", "score"):
        order_by = "confidence DESC, updated_at DESC"
    elif sort_key in ("confidence_asc", "conf_asc", "score_asc"):
        order_by = "confidence ASC, updated_at DESC"
    elif sort_key == "oldest":
        order_by = "updated_at ASC"
    else:
        order_by = "updated_at DESC"
    sql = f"SELECT * FROM {MEMORY_ROWSET} {where} ORDER BY {order_by} LIMIT ? OFFSET ?"
    count_sql = f"SELECT COUNT(*) as c FROM {MEMORY_ROWSET} {where}"
    conn = get_db()
    try:
        total = conn.execute(count_sql, params).fetchone()[0]
        rows = conn.execute(sql, params + [limit, offset]).fetchall()
    finally:
        conn.close()
    data = [dict(row) for row in rows]
    response = JSONResponse(content=data)
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/concepts")
def list_concepts(
    query: Optional[str] = None,
    scope: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    auth: dict = Depends(require_token),
):
    """
    Group memories by a stable "concept" key so wording variants collapse into one group.
    (Back-compat: falls back to normalized when concept is missing.)
    """
    clauses = ["COALESCE(concept, normalized) != ''"]
    params = []

    if query:
        clauses.append("(content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if status:
        clauses.append("status = ?")
        params.append(status)
    _apply_scope_filter(clauses, params, scope, auth)

    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    total_sql = f"SELECT COUNT(*) as c FROM (SELECT COALESCE(concept, normalized) AS concept_key FROM {MEMORY_ROWSET} {where} GROUP BY concept_key)"
    status_rank = """
        CASE status
            WHEN 'active' THEN 0
            WHEN 'pending' THEN 1
            WHEN 'superseded' THEN 2
            WHEN 'rejected' THEN 3
            ELSE 4
        END
    """

    sql = f"""
        WITH filtered AS (
            SELECT *, COALESCE(concept, normalized) AS concept_key FROM {MEMORY_ROWSET} {where}
        ),
        groups AS (
            SELECT
                concept_key,
                COUNT(*) AS count,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded_count,
                MAX(updated_at) AS latest_updated_at
            FROM filtered
            GROUP BY concept_key
        )
        SELECT
            g.concept_key,
            g.count,
            g.active_count,
            g.rejected_count,
            g.superseded_count,
            g.latest_updated_at,
            c.id AS canonical_id,
            c.type AS canonical_type,
            c.status AS canonical_status,
            c.scope AS canonical_scope,
            c.confidence AS canonical_confidence,
            c.pinned AS canonical_pinned,
            c.content AS canonical_content
        FROM groups g
        JOIN filtered c ON c.id = (
            SELECT id FROM filtered f
            WHERE f.concept_key = g.concept_key
            ORDER BY
                pinned DESC,
                {status_rank} ASC,
                COALESCE(confidence, 0) DESC,
                updated_at DESC
            LIMIT 1
        )
        ORDER BY g.count DESC, g.latest_updated_at DESC
        LIMIT ? OFFSET ?
    """

    conn = get_db()
    try:
        total = conn.execute(total_sql, params).fetchone()[0]
        rows = conn.execute(sql, params + [limit, offset]).fetchall()
    finally:
        conn.close()
    response = JSONResponse(content=[dict(r) for r in rows])
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/audit")
def audit_memories(
    scope: Optional[str] = None,
    min_confidence: float = Query(0.6, ge=0.0, le=1.0),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    auth: dict = Depends(require_token),
):
    """
    Surface suspicious "active" rows so the operator can clean up without spammy digests.
    """
    clauses = ["status = 'active'"]
    params = []
    _apply_scope_filter(clauses, params, scope, auth)
    where = "WHERE " + " AND ".join(clauses)
    conn = get_db()
    try:
        rows = conn.execute(
            f"SELECT * FROM {MEMORY_ROWSET} {where} ORDER BY updated_at DESC LIMIT ?",
            params + [MAX_AUDIT_SCAN_ROWS + 1],
        ).fetchall()
    finally:
        conn.close()
    scan_truncated = len(rows) > MAX_AUDIT_SCAN_ROWS
    rows = rows[:MAX_AUDIT_SCAN_ROWS]

    banned_re = re.compile(r"\b(openrouter|ollama|provider|model|embedding|api|token|sqlite|http|https|localhost|gateway|batch|v1/|11434)\b", re.I)
    secret_re = re.compile(r"\bsk-[a-z0-9]{10,}\b", re.I)
    metadata_re = re.compile(r"^\s*\*\*source\*\*\s*:\s*", re.I)
    trivial_re = re.compile(r"(?:^|\b)(is a user|ist ein user|read heartbeat|working on.*plugin|\bis (cool|nett|nice)\b)(?:$|\b)", re.I)

    findings = []
    for row in rows:
        r = dict(row)
        reasons = []
        content = (r.get("content") or "").strip()
        tags = r.get("tags") or ""
        if r.get("source") == "agent" and (banned_re.search(content) or secret_re.search(content)):
            reasons.append("agent_banned_tokens")
        if "\"agent-profile\"" in tags and (r.get("scope") == "shared" or not r.get("scope")):
            reasons.append("agent_profile_in_shared_scope")
        try:
            conf = float(r.get("confidence") or 0)
        except Exception:
            conf = 0.0
        if conf and conf < float(min_confidence):
            reasons.append("low_conf_active")
        if metadata_re.search(content):
            reasons.append("metadata_line")
        if len(content) < 12 or trivial_re.search(content):
            reasons.append("trivial_or_too_short")
        if reasons:
            r["reasons"] = reasons
            findings.append(r)

    total = len(findings)
    sliced = findings[offset: offset + limit]
    response = JSONResponse(content=sliced)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Audit-Scan-Truncated"] = "true" if scan_truncated else "false"
    return response


@app.get("/memories/{memory_id}")
def get_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    try:
        row = conn.execute(f"SELECT * FROM {MEMORY_ROWSET} WHERE id = ?", (memory_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        scope = str(row["scope"] or "shared")
        if not _is_admin(auth) and scope not in _allowed_scopes(auth):
            raise HTTPException(status_code=404, detail="Not found")
        evidence = conn.execute(
            "SELECT text_snippet, created_at FROM evidence WHERE memory_id = ?",
            (memory_id,),
        ).fetchall()
    finally:
        conn.close()
    data = dict(row)
    data["evidence"] = [dict(r) for r in evidence]
    return data


def _is_duplicate_memory_id_error(exc: sqlite3.IntegrityError) -> bool:
    error_code = getattr(exc, "sqlite_errorcode", None)
    duplicate_codes = {
        getattr(sqlite3, "SQLITE_CONSTRAINT_PRIMARYKEY", 1555),
        getattr(sqlite3, "SQLITE_CONSTRAINT_UNIQUE", 2067),
    }
    return error_code in duplicate_codes or "memory_current.memory_id" in str(exc) or "memories.id" in str(exc)


@app.post("/memories")
def create_memory(payload: MemoryCreatePayload, auth: dict = Depends(require_token)):
    mem_id = payload.id or str(uuid.uuid4())
    scope_value = _normalize_projection_scope(payload.scope or "shared")
    _ensure_scope_allowed(scope_value, auth)
    conn = get_db()
    try:
        try:
            with projection_batch(conn, f"api-create-{mem_id}") as batch:
                if conn.execute("SELECT 1 FROM memory_current WHERE memory_id=?", (mem_id,)).fetchone():
                    raise HTTPException(status_code=409, detail="Memory id already exists")
                _projection_upsert(conn, {
                    "memory_id": mem_id, "type": payload.type, "content": payload.content,
                    "source": payload.source or "user", "source_agent": payload.source_agent or "ui",
                    "source_session": payload.source_session or "ui", "source_kind": "api",
                    "confidence": payload.confidence, "scope": scope_value,
                    "status": payload.status or "active", "tags": payload.tags or [],
                    "superseded_by": payload.superseded_by,
                    "content_time": payload.content_time,
                    "valid_until": payload.valid_until,
                }, {
                    "concept": payload.concept, "source_message_id": payload.source_message_id,
                    "last_confirmed_at": payload.last_confirmed_at, "ttl_days": payload.ttl_days,
                    "pinned": payload.pinned, "review_version": payload.review_version,
                    "review_reason": payload.review_reason,
                }, batch["operation_id"], now=batch["now"])
        except sqlite3.IntegrityError as exc:
            if _is_duplicate_memory_id_error(exc):
                raise HTTPException(status_code=409, detail="Memory id already exists") from exc
            raise
    finally:
        conn.close()
    return {"id": mem_id}


@app.patch("/memories/{memory_id}")
def update_memory(memory_id: str, payload: MemoryUpdatePayload, auth: dict = Depends(require_token)):
    payload_data = payload.model_dump(exclude_unset=True)
    conn = get_db()
    try:
        _memory_scope_or_404(conn, memory_id, auth)
        if not payload_data:
            return {"ok": True}
        with projection_batch(conn, f"api-update-{memory_id}") as batch:
            core = dict(conn.execute("SELECT * FROM memory_current WHERE memory_id=?", (memory_id,)).fetchone())
            content_value = payload_data.get("content", core["content"])
            for key in ("type", "status", "content_time", "valid_until", "superseded_by", "confidence"):
                if key in payload_data:
                    core[key] = payload_data[key]
            if "tags" in payload_data:
                core["tags"] = payload_data.get("tags") or []
            core["content"] = content_value
            core["updated_at"] = batch["now"]
            metadata = {key: payload_data[key] for key in (
                "concept", "source_message_id", "last_injected_at", "last_confirmed_at",
                "ttl_days", "pinned", "review_version", "review_reason",
            ) if key in payload_data}
            _projection_upsert(conn, core, metadata, batch["operation_id"], now=batch["now"])
    finally:
        conn.close()
    return {"ok": True}


@app.get("/docs")
def list_docs(
    query: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    tag: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    auth: dict = Depends(require_token),
):
    _ensure_doc_access(auth)
    conn = get_db()
    clauses = []
    params = []
    if query:
        clauses.append("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
        like = _contains_like(query)
        params.extend([like, like, like])
    if source:
        clauses.append("source = ?")
        params.append(source)
    if status:
        clauses.append("status = ?")
        params.append(status)
    if tag:
        clauses.append("tags LIKE ? ESCAPE '\\'")
        params.append(_tag_like(tag))
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sort_key = (sort or "recent").lower()
    order_by = "updated_at ASC" if sort_key == "oldest" else "updated_at DESC"
    sql = f"SELECT * FROM documents {where} ORDER BY {order_by} LIMIT ? OFFSET ?"
    params.extend([limit, offset])
    count_sql = f"SELECT COUNT(*) as c FROM documents {where}"
    count_params = list(params[:-2])
    try:
        total = conn.execute(count_sql, count_params).fetchone()[0]
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        data = dict(row)
        data["preview"] = preview_doc_content(data.get("path"))
        out.append(data)
    response = JSONResponse(content=out)
    response.headers["X-Total-Count"] = str(total)
    return response


@app.get("/docs/{doc_id}")
def get_doc(doc_id: str, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    data = dict(row)
    data["content"] = read_doc_content(data.get("path"))
    return data


@app.post("/docs")
def create_doc(payload: DocCreatePayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    content = payload.content
    doc_id = payload.id or f"d:{uuid.uuid4()}"
    title = sanitize_title(payload.title or "Untitled document")
    source = payload.source or "text"
    url = payload.url or ""
    tags = payload.tags or []
    now = _iso_utc()
    file_path = write_doc_file(doc_id, title, source, url, tags, content, now)

    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO documents (
                id, title, source, url, path, status, tags, created_at, updated_at, last_indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc_id,
                title,
                source,
                url,
                file_path,
                payload.status or "active",
                json.dumps(tags),
                now,
                now,
                None,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    schedule_doc_index()
    return {"id": doc_id, "path": file_path}


@app.post("/docs/url")
def create_doc_from_url(payload: DocFromUrlPayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    url = payload.url
    if not ENABLE_URL_IMPORT:
        raise HTTPException(status_code=503, detail="URL import is disabled")
    host = _url_import_host(url)
    if not host or host not in URL_IMPORT_ALLOWLIST:
        raise HTTPException(status_code=400, detail="URL host is not allowlisted")
    if not ALLOW_PRIVATE_URLS and not is_public_http_url(url):
        raise HTTPException(status_code=400, detail="private or non-http URL blocked")
    try:
        title, content = _fetch_url_import(url, allow_private=ALLOW_PRIVATE_URLS)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="failed to fetch URL")

    return create_doc(
        DocCreatePayload(
            title=title,
            content=content,
            source="url",
            url=url,
            tags=payload.tags or [],
        ),
        auth,
    )


@app.post("/docs/file")
async def create_doc_from_file(file: UploadFile = File(...), auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    filename = str(file.filename or "upload").replace("\\", "/").rsplit("/", 1)[-1] or "upload"
    supplied_ext = os.path.splitext(filename)[1].lower()
    is_pdf = supplied_ext == ".pdf" or file.content_type == "application/pdf"
    if is_pdf:
        ext = ".pdf"
    elif supplied_ext in {".txt", ".md", ".markdown", ".json", ".csv"}:
        ext = supplied_ext
    else:
        ext = ".bin"
    content = ""
    source = "file"

    if is_pdf:
        source = "pdf"
        content = extract_text_from_pdf(data)
    else:
        content = data.decode("utf-8", errors="ignore")

    doc_id = f"d:{uuid.uuid4()}"
    title = sanitize_title(filename)
    tags = []
    now = _iso_utc()
    file_path = write_doc_file(doc_id, title, source, "", tags, content, now)

    ensure_docs_dir()
    raw_path = os.path.join(DOCS_DIR, "raw", f"{_safe_doc_filename(doc_id)}{ext}")
    raw_dir = os.path.dirname(raw_path)
    raw_fd = -1
    raw_temporary_path = ""
    try:
        raw_fd, raw_temporary_path = tempfile.mkstemp(
            prefix=".gigabrain-raw-", suffix=".tmp", dir=raw_dir
        )
        os.fchmod(raw_fd, 0o600)
        with os.fdopen(raw_fd, "wb") as raw_handle:
            raw_fd = -1
            raw_handle.write(data)
            raw_handle.flush()
            os.fsync(raw_handle.fileno())
        os.replace(raw_temporary_path, raw_path)
        os.chmod(raw_path, 0o600)
    except Exception:
        if raw_fd >= 0:
            os.close(raw_fd)
        if raw_temporary_path:
            try:
                os.unlink(raw_temporary_path)
            except FileNotFoundError:
                pass
        # The extracted document remains useful even if retaining its optional
        # raw source fails; do not turn a successful import into a 500.

    conn = get_db()
    try:
        conn.execute(
            """
            INSERT INTO documents (
                id, title, source, url, path, status, tags, created_at, updated_at, last_indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc_id,
                title,
                source,
                "",
                file_path,
                "active",
                json.dumps(tags),
                now,
                now,
                None,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    schedule_doc_index()
    return {"id": doc_id, "path": file_path}


@app.patch("/docs/{doc_id}")
def update_doc(doc_id: str, payload: DocUpdatePayload, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    payload_data = payload.model_dump(exclude_unset=True)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        record = dict(row)
        title = sanitize_title(payload_data.get("title") or record.get("title") or "Untitled document")
        source = payload_data.get("source") or record.get("source") or "text"
        url = payload_data.get("url") if "url" in payload_data else (record.get("url") or "")
        tags = payload_data.get("tags") if "tags" in payload_data else json.loads(record.get("tags") or "[]")
        status = payload_data.get("status") or record.get("status") or "active"
        content = payload_data.get("content")
        if content is None:
            content = strip_front_matter(read_doc_content(record.get("path")))
        now = _iso_utc()
        file_path = write_doc_file(
            doc_id,
            title,
            source,
            url,
            tags,
            content,
            record.get("created_at") or now,
            existing_path=record.get("path"),
        )

        conn.execute(
            """
            UPDATE documents SET title = ?, source = ?, url = ?, path = ?, status = ?, tags = ?, updated_at = ?
            WHERE id = ?
            """,
            (title, source, url, file_path, status, json.dumps(tags), now, doc_id),
        )
        conn.commit()
    finally:
        conn.close()
    schedule_doc_index()
    return {"ok": True}


@app.delete("/docs/{doc_id}")
def delete_doc(doc_id: str, auth: dict = Depends(require_token)):
    _ensure_doc_access(auth)
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        record = dict(row)
        conn.execute(
            "UPDATE documents SET status = 'deleted', updated_at = ? WHERE id = ?",
            (_iso_utc(), doc_id),
        )
        conn.commit()
    finally:
        conn.close()
    try:
        if record.get("path") and _is_within_docs_dir(record["path"]) and os.path.exists(record["path"]):
            os.remove(record["path"])
    except Exception:
        pass
    schedule_doc_index()
    return {"ok": True}


@app.get("/profile")
def profile(
    mode: str = "full",
    q: Optional[str] = None,
    scope: str = "shared",
    dynamic_window_days: int = Query(14, ge=1, le=3650),
    max_static_items: int = Query(50, ge=1, le=500),
    max_dynamic_items: int = Query(50, ge=1, le=500),
    min_confidence: float = Query(0.7, ge=0.0, le=1.0),
    auth: dict = Depends(require_token),
    conn: sqlite3.Connection = Depends(db_connection),
):
    """
    Profile endpoint:
    - mode=profile: return profile only
    - mode=query: return searchResults only (profile is empty)
    - mode=full: return profile + searchResults
    """
    mode_norm = (mode or "full").strip().lower()
    if mode_norm not in ("profile", "query", "full"):
        mode_norm = "full"

    scope_value = (scope or "shared").strip() or "shared"
    _ensure_scope_allowed(scope_value, auth)
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=max(1, int(dynamic_window_days or 14)))

    profile_static = []
    profile_dynamic = []

    if mode_norm in ("profile", "full"):
        static_rows = conn.execute(
            f"""
            SELECT * FROM {MEMORY_ROWSET}
            WHERE scope = ? AND status = 'active'
              AND (pinned = 1 OR confidence >= ?)
              AND type IN ('USER_FACT','PREFERENCE','ENTITY','DECISION')
            ORDER BY pinned DESC, confidence DESC, updated_at DESC
            LIMIT ?
            """,
            (scope_value, float(min_confidence), int(max_static_items)),
        ).fetchall()
        for r in static_rows or []:
            row = dict(r)
            if _is_expired(row, now):
                continue
            profile_static.append(row)

        dynamic_rows = conn.execute(
            f"""
            SELECT * FROM {MEMORY_ROWSET}
            WHERE scope = ? AND status = 'active'
              AND type IN ('CONTEXT','EPISODE')
              AND updated_at >= ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (scope_value, _iso_utc(since), int(max_dynamic_items)),
        ).fetchall()
        for r in dynamic_rows or []:
            row = dict(r)
            if _is_expired(row, now):
                continue
            profile_dynamic.append(row)

        # Recent updates (updates-only relations) are useful "dynamic" context.
        try:
            update_rows = conn.execute(
                f"""
                SELECT m.* FROM {MEMORY_ROWSET} m
                JOIN memory_relations r ON r.to_memory_id = m.id
                WHERE m.scope = ? AND m.status = 'active'
                  AND r.relation_type = 'updates'
                  AND m.type IN ('USER_FACT','PREFERENCE','DECISION')
                  AND m.updated_at >= ?
                ORDER BY m.updated_at DESC
                LIMIT ?
                """,
                (scope_value, _iso_utc(since), int(max_dynamic_items)),
            ).fetchall()
            seen = set([x.get("id") for x in profile_dynamic])
            for r in update_rows or []:
                row = dict(r)
                if row.get("id") in seen:
                    continue
                if _is_expired(row, now):
                    continue
                profile_dynamic.append(row)
                seen.add(row.get("id"))
                if len(profile_dynamic) >= int(max_dynamic_items):
                    break
        except Exception:
            pass

    search_results = []
    if mode_norm in ("query", "full") and q:
        tokens = normalize_content(q).split()
        if tokens:
            like = _contains_like(" ".join(tokens[:4]))
            rows = conn.execute(
                f"""
                SELECT * FROM {MEMORY_ROWSET}
                WHERE scope = ? AND status = 'active'
                  AND (content LIKE ? ESCAPE '\\' OR normalized LIKE ? ESCAPE '\\' OR concept LIKE ? ESCAPE '\\')
                ORDER BY confidence DESC, updated_at DESC
                LIMIT 50
                """,
                (scope_value, like, like, like),
            ).fetchall()
            for r in rows or []:
                row = dict(r)
                if _is_expired(row, now):
                    continue
                search_results.append(row)

    out = {
        "mode": mode_norm,
        "q": q,
        "profile": {
            "static": profile_static,
            "dynamic": profile_dynamic,
        },
    }
    if mode_norm in ("query", "full"):
        out["searchResults"] = search_results
    return out


@app.get("/memories/{memory_id}/relations")
def memory_relations(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    try:
        _memory_scope_or_404(conn, memory_id, auth)
        rels = conn.execute(
            """
            SELECT * FROM memory_relations
            WHERE from_memory_id = ? OR to_memory_id = ?
            ORDER BY created_at DESC
            LIMIT 500
            """,
            (memory_id, memory_id),
        ).fetchall()
        filtered = _filter_relation_rows(conn, rels, auth)
    finally:
        conn.close()
    return {"id": memory_id, "relations": filtered}


@app.get("/relations")
def list_relations(
    from_id: Optional[str] = Query(None, alias="from"),
    to_id: Optional[str] = Query(None, alias="to"),
    relation_type: str = "updates",
    limit: int = Query(200, ge=1, le=1000),
    auth: dict = Depends(require_token),
):
    clauses = []
    params = []
    from_memory_id = from_id
    to_memory_id = to_id
    if from_memory_id:
        clauses.append("from_memory_id = ?")
        params.append(from_memory_id)
    if to_memory_id:
        clauses.append("to_memory_id = ?")
        params.append(to_memory_id)
    if relation_type:
        clauses.append("relation_type = ?")
        params.append(relation_type)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""

    conn = get_db()
    try:
        if from_memory_id:
            _memory_scope_or_404(conn, from_memory_id, auth)
        if to_memory_id:
            _memory_scope_or_404(conn, to_memory_id, auth)
        if not _is_admin(auth) and not from_memory_id and not to_memory_id:
            raise HTTPException(status_code=403, detail="from/to filter required for scoped tokens")

        rows = conn.execute(
            f"SELECT * FROM memory_relations {where} ORDER BY created_at DESC LIMIT ?",
            params + [limit],
        ).fetchall()
        filtered = _filter_relation_rows(conn, rows, auth)
    finally:
        conn.close()
    return filtered


@app.post("/memories/{memory_id}/confirm")
def confirm_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    try:
        with projection_batch(conn, f"api-confirm-{memory_id}") as batch:
            _memory_scope_or_404(conn, memory_id, auth)
            row = _memory_api_row(conn, memory_id)
            concept = row["concept"] or row["normalized"]
            cohort = conn.execute(f"""SELECT id FROM {MEMORY_ROWSET}
              WHERE scope=? AND (concept=? OR (concept IS NULL AND normalized=?))""",
              (row["scope"], concept, row["normalized"])).fetchall()
            now = batch["now"]
            for item in cohort:
                target = item["id"]
                _projection_status(conn, target, "active" if target == memory_id else "superseded",
                    batch["operation_id"], superseded_by=None if target == memory_id else memory_id,
                    clear_superseded=target == memory_id,
                    metadata={"last_confirmed_at": now} if target == memory_id else None,
                    timestamp=now)
    finally:
        conn.close()
    return {"ok": True}


@app.post("/memories/{memory_id}/reject")
def reject_memory(memory_id: str, auth: dict = Depends(require_token)):
    conn = get_db()
    try:
        with projection_batch(conn, f"api-reject-{memory_id}") as batch:
            _memory_scope_or_404(conn, memory_id, auth)
            row = _memory_api_row(conn, memory_id)
            concept = row["concept"] or row["normalized"]
            cohort = conn.execute(f"""SELECT id FROM {MEMORY_ROWSET}
              WHERE scope=? AND (concept=? OR (concept IS NULL AND normalized=?))""",
              (row["scope"], concept, row["normalized"])).fetchall()
            for item in cohort:
                _projection_status(conn, item["id"], "rejected", batch["operation_id"],
                    clear_superseded=True, timestamp=batch["now"])
    finally:
        conn.close()
    return {"ok": True}


@app.post("/memories/merge")
def merge_memories(payload: MergeMemoriesPayload, auth: dict = Depends(require_token)):
    ids = payload.ids or []
    if len(ids) < 2:
        raise HTTPException(status_code=400, detail="ids required")
    primary = ids[0]
    conn = get_db()
    try:
        with projection_batch(conn, f"api-merge-{primary}") as batch:
            primary_scope = _memory_scope_or_404(conn, primary, auth)
            for mid in ids[1:]:
                scope = _memory_scope_or_404(conn, mid, auth)
                if scope != primary_scope:
                    raise HTTPException(status_code=400, detail="all memories must share scope")
            _projection_status(conn, primary, "active", batch["operation_id"], clear_superseded=True, timestamp=batch["now"])
            for mid in ids[1:]:
                _projection_status(conn, mid, "superseded", batch["operation_id"], superseded_by=primary, timestamp=batch["now"])
                conn.execute(
                    """
                    INSERT INTO memory_relations (
                        id, from_memory_id, to_memory_id, relation_type, created_at, source, confidence
                    ) VALUES (?, ?, ?, 'updates', ?, 'ui', 0.9)
                    """,
                    (str(uuid.uuid4()), mid, primary, batch["now"]),
                )
    finally:
        conn.close()
    return {"ok": True, "primary": primary}


@app.post("/recall/explain")
def recall_explain(payload: RecallExplainPayload, auth: dict = Depends(require_token)):
    query = payload.query
    if not query.strip():
        return {"strategy": "quick_context", "result_count": 0, "results": []}
    effective_scope = _resolve_single_scope(payload.scope, auth)

    if _is_loopback_http_url(GB_RECALL_EXPLAIN_URL):
        try:
            headers = {"Authorization": f"Bearer {PLUGIN_PROXY_TOKEN}"} if PLUGIN_PROXY_TOKEN else {}
            with httpx.Client(timeout=4.0, trust_env=False) as client:
                response = client.post(
                    GB_RECALL_EXPLAIN_URL,
                    headers=headers,
                    json={"query": query, "scope": effective_scope},
                )
                if response.status_code == 200:
                    return response.json()
        except Exception:
            pass

    tokens = normalize_content(query).split()
    if not tokens:
        return {"strategy": "quick_context", "result_count": 0, "results": []}
    like = _contains_like(" ".join(tokens[:3]))

    conn = get_db()
    try:
        clauses = ["status = 'active'", "normalized LIKE ? ESCAPE '\\'"]
        params: list[Any] = [like]
        _apply_scope_filter(clauses, params, payload.scope, auth)
        where = " WHERE " + " AND ".join(clauses)
        rows = conn.execute(
            f"SELECT * FROM {MEMORY_ROWSET} {where} ORDER BY confidence DESC LIMIT 10",
            params,
        ).fetchall()
    finally:
        conn.close()
    return {
        "strategy": "fallback_sql_like",
        "deep_lookup_allowed": False,
        "used_world_model": False,
        "result_count": len(rows),
        "results": [dict(r) for r in rows],
    }


@app.get("/graph")
def graph(auth: dict = Depends(require_token)):
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="Graph endpoint requires admin token")
    if not os.path.exists(GRAPH_PATH):
        return {"generated_at": None, "nodes": [], "edges": []}
    try:
        with open(GRAPH_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if "nodes" not in data or "edges" not in data:
            return {"generated_at": None, "nodes": [], "edges": []}
        return data
    except Exception:
        return {"generated_at": None, "nodes": [], "edges": []}


@app.get("/surface")
def surface(auth: dict = Depends(require_token)):
    if not _is_admin(auth):
        raise HTTPException(status_code=403, detail="Surface endpoint requires admin token")
    if not os.path.exists(SURFACE_SUMMARY_PATH):
        return _default_surface_summary()
    try:
        with open(SURFACE_SUMMARY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _default_surface_summary()
        data.setdefault("surface_summary_path", SURFACE_SUMMARY_PATH)
        return data
    except Exception:
        return _default_surface_summary()


@app.get("/world/summary")
def world_summary(auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            return {
                "generated_at": None,
                "counts": {
                    "entities": 0,
                    "beliefs": 0,
                    "episodes": 0,
                    "open_loops": 0,
                    "contradictions": 0,
                    "syntheses": 0,
                },
                "latest_session_brief": None,
            }
        counts = {}
        entity_rows = conn.execute("SELECT payload FROM memory_entities").fetchall()
        visible_entities = 0
        for row in entity_rows:
            try:
                payload = json.loads(row["payload"] or "{}")
            except Exception:
                payload = {}
            if payload.get("surface_visible", True) is False:
                continue
            visible_entities += 1
        counts["entities"] = visible_entities
        for table_name in ["memory_beliefs", "memory_episodes", "memory_open_loops", "memory_syntheses"]:
            counts[table_name.replace("memory_", "")] = int(
                conn.execute(f"SELECT COUNT(*) AS c FROM {table_name}").fetchone()["c"] or 0
            )
        contradictions = int(
            conn.execute(
                "SELECT COUNT(*) AS c FROM memory_open_loops WHERE kind = 'contradiction_review'"
            ).fetchone()["c"] or 0
        )
        latest = conn.execute(
            """
            SELECT synthesis_id, kind, content, generated_at, confidence
            FROM memory_syntheses
            WHERE kind = 'session_brief'
            ORDER BY generated_at DESC
            LIMIT 1
            """
        ).fetchone()
        generated = conn.execute(
            "SELECT COALESCE(MAX(generated_at), '') AS generated_at FROM memory_syntheses"
        ).fetchone()["generated_at"]
        return {
            "generated_at": generated or None,
            "counts": {
                "entities": counts.get("entities", 0),
                "beliefs": counts.get("beliefs", 0),
                "episodes": counts.get("episodes", 0),
                "open_loops": counts.get("open_loops", 0),
                "contradictions": contradictions,
                "syntheses": counts.get("syntheses", 0),
            },
            "latest_session_brief": dict(latest) if latest else None,
        }
    finally:
        conn.close()


@app.get("/world/entities")
def world_entities(
    kind: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            return []
        clauses = []
        params: list[Any] = []
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
            FROM memory_entities
            {where}
            ORDER BY updated_at DESC, display_name ASC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        items = []
        for row in rows:
            payload = json.loads(row["payload"] or "{}")
            if payload.get("surface_visible", True) is False:
                continue
            items.append({
                **dict(row),
                "aliases": json.loads(row["aliases"] or "[]"),
                "payload": payload,
            })
        return items
    finally:
        conn.close()


@app.get("/world/entities/{entity_id}")
def world_entity_detail(entity_id: str, auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_entities"):
            raise HTTPException(status_code=404, detail="World model unavailable")
        entity = conn.execute(
            """
            SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
            FROM memory_entities
            WHERE entity_id = ?
            LIMIT 1
            """,
            (entity_id,),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")
        beliefs = conn.execute(
            """
            SELECT belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
                   supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
            FROM memory_beliefs
            WHERE entity_id = ?
            ORDER BY COALESCE(valid_from, '') DESC, confidence DESC
            LIMIT 200
            """,
            (entity_id,),
        ).fetchall()
        episodes = conn.execute(
            """
            SELECT episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload
            FROM memory_episodes
            WHERE primary_entity_id = ?
            ORDER BY COALESCE(start_date, '') DESC
            LIMIT 100
            """,
            (entity_id,),
        ).fetchall()
        loops = conn.execute(
            """
            SELECT loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
            FROM memory_open_loops
            WHERE related_entity_id = ?
            ORDER BY priority DESC, title ASC
            LIMIT 100
            """,
            (entity_id,),
        ).fetchall()
        syntheses = conn.execute(
            """
            SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
            FROM memory_syntheses
            WHERE subject_type = 'entity' AND subject_id = ?
            ORDER BY generated_at DESC, kind ASC
            LIMIT 50
            """,
            (entity_id,),
        ).fetchall()
        return {
            **dict(entity),
            "aliases": json.loads(entity["aliases"] or "[]"),
            "payload": json.loads(entity["payload"] or "{}"),
            "beliefs": [{**dict(row), "payload": json.loads(row["payload"] or "{}")} for row in beliefs],
            "episodes": [
                {
                    **dict(row),
                    "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in episodes
            ],
            "open_loops": [
                {
                    **dict(row),
                    "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in loops
            ],
            "syntheses": [
                {
                    **dict(row),
                    "stale": bool(row["stale"]),
                    "payload": json.loads(row["payload"] or "{}"),
                }
                for row in syntheses
            ],
        }
    finally:
        conn.close()


@app.get("/world/beliefs")
def world_beliefs(
    entity_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_beliefs"):
            return []
        clauses = []
        params: list[Any] = []
        if entity_id:
            clauses.append("entity_id = ?")
            params.append(entity_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
                   supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
            FROM memory_beliefs
            {where}
            ORDER BY COALESCE(valid_from, '') DESC, confidence DESC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        return [{**dict(row), "payload": json.loads(row["payload"] or "{}")} for row in rows]
    finally:
        conn.close()


@app.get("/world/open-loops")
def world_open_loops(
    entity_id: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 200,
    auth: dict = Depends(require_token),
):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_open_loops"):
            return []
        clauses = []
        params: list[Any] = []
        if entity_id:
            clauses.append("related_entity_id = ?")
            params.append(entity_id)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"""
            SELECT loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
            FROM memory_open_loops
            {where}
            ORDER BY priority DESC, title ASC
            LIMIT ?
            """,
            (*params, max(1, min(limit, 1000))),
        ).fetchall()
        return [
            {
                **dict(row),
                "source_memory_ids": json.loads(row["source_memory_ids"] or "[]"),
                "payload": json.loads(row["payload"] or "{}"),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/world/contradictions")
def world_contradictions(limit: int = 200, auth: dict = Depends(require_token)):
    return world_open_loops(kind="contradiction_review", limit=limit, auth=auth)


@app.get("/world/briefings")
def world_briefings(limit: int = 50, auth: dict = Depends(require_token)):
    _require_admin_world(auth)
    conn = get_db()
    try:
        if not _has_table(conn, "memory_syntheses"):
            return []
        rows = conn.execute(
            """
            SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
            FROM memory_syntheses
            WHERE kind IN ('session_brief', 'daily_memory_briefing', 'what_changed', 'open_loops_report', 'contradiction_report')
            ORDER BY generated_at DESC, kind ASC
            LIMIT ?
            """,
            (max(1, min(limit, 200)),),
        ).fetchall()
        return [
            {
                **dict(row),
                "stale": bool(row["stale"]),
                "payload": json.loads(row["payload"] or "{}"),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/metrics")
def metrics(
    auth: dict = Depends(require_token),
    conn: sqlite3.Connection = Depends(db_connection),
):
    allowed = sorted(_allowed_scopes(auth))
    if _is_admin(auth):
        total = conn.execute("SELECT COUNT(*) as c FROM memory_current").fetchone()[0]
        active = conn.execute("SELECT COUNT(*) as c FROM memory_current WHERE status = 'active'").fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) as c FROM memory_current WHERE status = 'pending'").fetchone()[0]
        rejected = conn.execute("SELECT COUNT(*) as c FROM memory_current WHERE status = 'rejected'").fetchone()[0]
    elif allowed:
        placeholders = ",".join("?" for _ in allowed)
        total = conn.execute(f"SELECT COUNT(*) as c FROM memory_current WHERE scope IN ({placeholders})", allowed).fetchone()[0]
        active = conn.execute(
            f"SELECT COUNT(*) as c FROM memory_current WHERE status = 'active' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
        pending = conn.execute(
            f"SELECT COUNT(*) as c FROM memory_current WHERE status = 'pending' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
        rejected = conn.execute(
            f"SELECT COUNT(*) as c FROM memory_current WHERE status = 'rejected' AND scope IN ({placeholders})",
            allowed,
        ).fetchone()[0]
    else:
        total = active = pending = rejected = 0
    if _is_admin(auth):
        docs = conn.execute("SELECT COUNT(*) as c FROM documents").fetchone()[0]
        docs_active = conn.execute("SELECT COUNT(*) as c FROM documents WHERE status = 'active'").fetchone()[0]
    else:
        docs = 0
        docs_active = 0
    return {
        "total": total,
        "active": active,
        "pending": pending,
        "rejected": rejected,
        "docs_total": docs,
        "docs_active": docs_active,
    }
