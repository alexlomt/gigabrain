import path from "node:path";

function parseJsonReport(output) {
  const text = String(output || "").trim();
  const candidates = [text];
  for (let index = 0; index < text.length; index += 1) {
    if ((text[index] === "[" || text[index] === "{") && index > 0 && text[index - 1] === "\n") {
      candidates.push(text.slice(index));
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate);
    } catch {
      // npm can prefix machine output with warnings; try the next JSON boundary.
    }
  }
  throw new Error("npm pack inventory was not valid JSON");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateReport(report) {
  if (!isObject(report)) throw new Error("npm pack report was not an object");
  if (typeof report.name !== "string" || report.name.trim() !== report.name || report.name.length === 0) {
    throw new Error("npm pack report name is required");
  }
  if (!Array.isArray(report.files) || report.files.length === 0) {
    throw new Error("npm pack inventory did not contain a file list for every report");
  }
  if (
    Object.hasOwn(report, "entryCount")
    && (!Number.isSafeInteger(report.entryCount) || report.entryCount !== report.files.length)
  ) {
    throw new Error("npm pack report entry count did not match its file inventory");
  }
  const seen = new Set();
  for (const entry of report.files) {
    if (!isObject(entry)) throw new Error("npm pack inventory contained an invalid file entry");
    const file = String(entry.path || "");
    if (
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file.includes("\0") ||
      path.posix.normalize(file) !== file ||
      file.split("/").includes("..") ||
      seen.has(file)
    ) {
      throw new Error("npm pack inventory contained an invalid file path");
    }
    seen.add(file);
  }
  return report;
}

export function parseNpmPackReports(output) {
  const root = parseJsonReport(output);
  if (Array.isArray(root)) {
    if (root.length === 0) throw new Error("npm pack inventory did not contain a file list for every report");
    return root.map(validateReport);
  }
  if (!isObject(root) || Object.keys(root).length === 0) {
    throw new Error("npm pack report was not an object");
  }
  return Object.entries(root).map(([packageKey, report]) => {
    const validated = validateReport(report);
    if (packageKey !== validated.name) throw new Error("npm 12 package key did not match report name");
    return validated;
  });
}

export function parseNpmPackInventory(output) {
  const reports = parseNpmPackReports(output);
  const entries = reports.flatMap((report) => report.files);
  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    const file = String(entry.path);
    if (seen.has(file)) throw new Error("npm pack inventory contained a duplicate file path");
    seen.add(file);
    files.push(file);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
