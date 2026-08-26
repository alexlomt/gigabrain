import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const normalizeSqlValue = (value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return { bigint: String(value) };
  return value;
};

const snapshotLogicalDatabase = (dbPath) => {
  const resolved = String(dbPath || "").trim();
  if (!resolved || !fs.existsSync(resolved)) return { exists: false, hash: "missing", tables: [] };
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    try { db.exec("PRAGMA query_only = ON"); } catch { /* connection-local hardening */ }
    const schema = db.prepare(`
      SELECT name, type, COALESCE(sql, '') AS sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables = [];
    for (const row of schema.filter((entry) => entry.type === "table")) {
      const name = String(row.name || "");
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const values = db.prepare(`SELECT * FROM ${quoted}`).all().map((entry) => Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [key, normalizeSqlValue(value)]),
      ));
      values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
      tables.push({ name, rows: values });
    }
    const logical = { schema, tables };
    return { exists: true, hash: sha256(JSON.stringify(logical)), tables: tables.map((table) => ({ name: table.name, rows: table.rows.length })) };
  } finally {
    db.close();
  }
};

const isDatabaseSidecar = (filePath) => /(?:\.sqlite|\.sqlite3|\.db)(?:-(?:shm|wal|journal))?$/i.test(filePath);

const snapshotRoot = (rootPath) => {
  const root = String(rootPath || "").trim();
  if (!root || !fs.existsSync(root)) return { exists: false, hash: "missing", root };
  const rows = [];
  const walk = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      const mode = stat.mode & 0o777;
      if (entry.isSymbolicLink()) {
        rows.push({ mode, path: relative, target: fs.readlinkSync(absolute), type: "symlink" });
      } else if (entry.isDirectory()) {
        rows.push({ mode, path: relative, type: "directory" });
        walk(absolute, relative);
      } else if (entry.isFile() && !isDatabaseSidecar(relative)) {
        rows.push({ hash: sha256(fs.readFileSync(absolute)), mode, path: relative, size: stat.size, type: "file" });
      }
    }
  };
  walk(root);
  return { exists: true, hash: sha256(JSON.stringify(rows)), root, rows };
};

const snapshotFile = (filePath) => {
  const resolved = String(filePath || "").trim();
  if (!resolved || !fs.existsSync(resolved)) return { exists: false, hash: "missing", path: resolved };
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, mode: stat.mode & 0o777, path: resolved, type: stat.isSymbolicLink() ? "symlink" : "non-regular" };
  }
  return { exists: true, hash: sha256(fs.readFileSync(resolved)), mode: stat.mode & 0o777, path: resolved, size: stat.size, type: "file" };
};

const snapshotObservationalState = ({ dbPath = "", roots = [], files = [] } = {}) => ({
  database: snapshotLogicalDatabase(dbPath),
  files: [...new Set(files.map((item) => String(item || "")).filter(Boolean))].sort().map(snapshotFile),
  roots: [...new Set(roots.map((item) => String(item || "")).filter(Boolean))].sort().map(snapshotRoot),
});

const assertObservationalStateUnchanged = (before, after, label = "diagnostic") => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const error = new Error(`GIGABRAIN_DIAGNOSTIC_MUTATION: ${label}`);
    error.code = "GIGABRAIN_DIAGNOSTIC_MUTATION";
    error.before = before;
    error.after = after;
    throw error;
  }
  return true;
};

const runObservationalDiagnostic = async ({ inspect, stateOptions } = {}) => {
  if (typeof inspect !== "function") throw new Error("GIGABRAIN_DIAGNOSTIC_INSPECT_REQUIRED");
  const before = snapshotObservationalState(stateOptions);
  const result = await inspect();
  assertObservationalStateUnchanged(before, snapshotObservationalState(stateOptions));
  return { result, observational: true };
};

export {
  assertObservationalStateUnchanged,
  runObservationalDiagnostic,
  snapshotLogicalDatabase,
  snapshotObservationalState,
};
