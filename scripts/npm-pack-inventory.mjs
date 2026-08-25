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

function packageReports(report) {
  if (Array.isArray(report)) return report;
  if (report && typeof report === "object") return Object.values(report);
  return [];
}

export function parseNpmPackReports(output) {
  const reports = packageReports(parseJsonReport(output));
  const entries = reports.flatMap((report) => Array.isArray(report?.files) ? report.files : []);
  if (reports.length === 0 || entries.length === 0) {
    throw new Error("npm pack inventory did not contain a file list");
  }
  return reports;
}

export function parseNpmPackInventory(output) {
  const reports = parseNpmPackReports(output);
  const entries = reports.flatMap((report) => report.files);
  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    const file = String(entry?.path || "");
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
    files.push(file);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
