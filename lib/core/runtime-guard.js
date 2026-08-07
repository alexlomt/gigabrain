const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;
const MIN_NODE_PATCH = 0;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}`;

const isSupportedVersion = ({ major, minor, patch }) => (
  major > MIN_NODE_MAJOR
  || (major === MIN_NODE_MAJOR && minor > MIN_NODE_MINOR)
  || (major === MIN_NODE_MAJOR && minor === MIN_NODE_MINOR && patch >= MIN_NODE_PATCH)
);

const parseNodeVersion = (raw = '') => {
  const input = String(raw || '').trim().replace(/^v/i, '');
  const match = input.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return {
      raw: String(raw || ''),
      major: NaN,
      minor: NaN,
      patch: NaN,
      ok: false,
    };
  }
  const major = Number.parseInt(match[1] || '', 10);
  const minor = Number.parseInt(match[2] || '0', 10);
  const patch = Number.parseInt(match[3] || '0', 10);
  return {
    raw: String(raw || ''),
    major,
    minor,
    patch,
    ok: Number.isInteger(major) && isSupportedVersion({ major, minor, patch }),
  };
};

const describeUnsupportedNode = ({
  component = 'Gigabrain',
  binary = process.execPath,
  version = process.version,
} = {}) => {
  return [
    `${component} requires Node.js >= ${MIN_NODE_VERSION} because it uses node:sqlite and built-in TypeScript type stripping.`,
    `Detected binary: ${String(binary || process.execPath)}`,
    `Detected version: ${String(version || process.version)}`,
    `Install or run with Node ${MIN_NODE_VERSION}+ and try again.`,
  ].join('\n');
};

const ensureSupportedNodeRuntime = ({
  component = 'Gigabrain',
  binary = process.execPath,
  version = process.version,
} = {}) => {
  const parsed = parseNodeVersion(version);
  if (parsed.ok) return parsed;
  const error = new Error(describeUnsupportedNode({ component, binary, version }));
  error.code = 'GB_UNSUPPORTED_NODE';
  error.minimumMajor = MIN_NODE_MAJOR;
  error.minimumVersion = MIN_NODE_VERSION;
  error.detectedVersion = String(version || '');
  throw error;
};

export {
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  MIN_NODE_PATCH,
  MIN_NODE_VERSION,
  parseNodeVersion,
  describeUnsupportedNode,
  ensureSupportedNodeRuntime,
};
