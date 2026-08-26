import { createHash } from "node:crypto";
import path from "node:path";

export const STRUCTURAL_FINGERPRINT_ALGORITHM = "source-token-window-v1";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".sh", ".ts"]);
const MULTI_CHAR_TOKENS = [
  ">>>=", "**=", "&&=", "??=", "||=", "===", "!==", ">>>", "<<=", ">>=", "=>",
  "**", "&&", "??", "||", "==", "!=", "<=", ">=", "++", "--", "<<", ">>",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "?.", "...",
].sort((left, right) => right.length - left.length);

const isIdentifierStart = (char) => /[A-Za-z_$]/u.test(char);
const isIdentifierPart = (char) => /[A-Za-z0-9_$-]/u.test(char);
const isNumberPart = (char) => /[A-Za-z0-9_.]/u.test(char);
const REGEX_PREFIX_TOKENS = new Set([
  "(", "{", "[", ",", ";", ":", "=", "==", "===", "!=", "!==", "!", "&&", "||",
  "??", "?", "=>", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">", "<=", ">=",
  "return", "case", "throw", "else", "do", "typeof", "instanceof", "in", "of", "yield",
  "await", "delete", "new", "void",
]);

export function isStructuralSourcePath(relativePath) {
  return SOURCE_EXTENSIONS.has(path.posix.extname(String(relativePath || "").toLowerCase()));
}

export function tokenizeStructuralSource(value) {
  const source = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  if (source.includes("\0")) return [];
  const tokens = [];
  let index = 0;
  let lineStart = true;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      if (char === "\n" || char === "\r") lineStart = true;
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2);
      if (index === -1) break;
      lineStart = true;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        tokens.push("/");
        tokens.push("*");
        index += 2;
        continue;
      }
      const comment = source.slice(index, end + 2);
      if (comment.includes("\n") || comment.includes("\r")) lineStart = true;
      index = end + 2;
      continue;
    }
    if (char === "#" && lineStart) {
      index = source.indexOf("\n", index + 1);
      if (index === -1) break;
      lineStart = true;
      continue;
    }
    lineStart = false;
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < source.length) {
        const current = source[end];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      if (end > source.length || source[end - 1] !== quote) {
        tokens.push(char);
        index += 1;
        continue;
      }
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (char === "/" && (tokens.length === 0 || REGEX_PREFIX_TOKENS.has(tokens.at(-1)))) {
      let end = index + 1;
      let escaped = false;
      let inClass = false;
      while (end < source.length) {
        const current = source[end];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === "[") {
          inClass = true;
        } else if (current === "]") {
          inClass = false;
        } else if (current === "/" && !inClass) {
          end += 1;
          while (end < source.length && /[A-Za-z]/u.test(source[end])) end += 1;
          break;
        } else if (current === "\n" || current === "\r") {
          break;
        }
        end += 1;
      }
      if (end <= source.length && source.slice(index + 1, end).includes("/")) {
        tokens.push(source.slice(index, end));
        index = end;
        continue;
      }
    }
    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (/[0-9]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && isNumberPart(source[end])) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    const multi = MULTI_CHAR_TOKENS.find((token) => source.startsWith(token, index));
    if (multi) {
      tokens.push(multi);
      index += multi.length;
      continue;
    }
    tokens.push(char);
    index += 1;
  }
  return tokens;
}

export function hashStructuralTokenWindow(tokens, start, tokenCount) {
  if (
    !Array.isArray(tokens)
    || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(tokenCount)
    || start < 0
    || tokenCount < 1
    || start + tokenCount > tokens.length
  ) {
    throw new Error("invalid structural token window");
  }
  const digest = createHash("sha256");
  for (let index = start; index < start + tokenCount; index += 1) {
    const token = tokens[index];
    digest.update(String(Buffer.byteLength(token, "utf8")));
    digest.update(":");
    digest.update(token);
    digest.update(";");
  }
  return digest.digest("hex");
}

export function findRetiredStructuralFingerprintMatches(files, fingerprints) {
  if (!Array.isArray(files) || !Array.isArray(fingerprints)) {
    throw new Error("structural fingerprint inputs must be arrays");
  }
  const byCount = new Map();
  for (const fingerprint of fingerprints) {
    if (
      fingerprint?.algorithm !== STRUCTURAL_FINGERPRINT_ALGORITHM
      || !Number.isSafeInteger(fingerprint.tokenCount)
      || fingerprint.tokenCount < 1
      || !/^[0-9a-f]{64}$/u.test(String(fingerprint.sha256 || ""))
    ) {
      throw new Error("invalid structural fingerprint");
    }
    const rows = byCount.get(fingerprint.tokenCount) || [];
    rows.push(fingerprint);
    byCount.set(fingerprint.tokenCount, rows);
  }
  const matches = [];
  for (const file of files) {
    if (!isStructuralSourcePath(file.path)) continue;
    const tokens = tokenizeStructuralSource(file.bytes);
    for (const [tokenCount, rows] of byCount) {
      if (tokens.length < tokenCount) continue;
      const expected = new Map(rows.map((row) => [row.sha256, row]));
      for (let start = 0; start <= tokens.length - tokenCount; start += 1) {
        const digest = hashStructuralTokenWindow(tokens, start, tokenCount);
        const fingerprint = expected.get(digest);
        if (!fingerprint) continue;
        matches.push({
          behaviorId: fingerprint.behaviorId,
          path: file.path,
          sourcePath: fingerprint.path,
        });
      }
    }
  }
  return matches.sort((left, right) => (
    `${left.behaviorId}\0${left.path}\0${left.sourcePath}`
      .localeCompare(`${right.behaviorId}\0${right.path}\0${right.sourcePath}`, "en")
  ));
}
