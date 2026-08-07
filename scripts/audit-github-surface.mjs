#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  BANNED_IDENTIFIER_HASHES,
  BANNED_TOKEN_HASHES,
  formatFinding,
  scanText,
} from './privacy-policy.mjs';

const bannedIdentifierHashes = new Set(BANNED_IDENTIFIER_HASHES);
const bannedTokenHashes = new Set(BANNED_TOKEN_HASHES);
const sourceOnlyFixtureModule = new URL('./private-scan-fixtures.mjs', import.meta.url);
if (existsSync(sourceOnlyFixtureModule)) {
  const sourceOnly = await import(sourceOnlyFixtureModule.href);
  for (const hash of sourceOnly.SOURCE_ONLY_BANNED_IDENTIFIER_HASHES || []) {
    bannedIdentifierHashes.add(String(hash));
  }
  for (const hash of sourceOnly.SOURCE_ONLY_BANNED_TOKEN_HASHES || []) {
    bannedTokenHashes.add(String(hash));
  }
}

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || '') : '';
};
const repo = valueFor('--repo') || process.env.GITHUB_REPOSITORY || '';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
  console.error('Usage: node scripts/audit-github-surface.mjs --repo owner/repository');
  process.exit(2);
}

const [owner, name] = repo.split('/');
const maxBuffer = 100 * 1024 * 1024;

const runGh = (ghArgs, label, optional = false) => {
  const result = spawnSync('gh', ghArgs, {
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    if (optional && /(?:HTTP 404|HTTP 403|not found|disabled)/iu.test(String(result.stderr || ''))) return null;
    throw new Error(`GitHub API request failed for ${label}; response details suppressed`);
  }
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    throw new Error(`GitHub API returned invalid JSON for ${label}`);
  }
};

const api = (endpoint, { optional = false, paginate = false } = {}) => runGh(
  ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint],
  endpoint.split('?')[0],
  optional,
);

const pagedItems = (payload, key = '') => {
  if (payload === null) return [];
  const pages = Array.isArray(payload) ? payload : [payload];
  return pages.flatMap((page) => {
    if (key && Array.isArray(page?.[key])) return page[key];
    if (Array.isArray(page)) return page;
    return [];
  });
};

const findings = [];
const aggregate = [];
let fieldsScanned = 0;
const scanField = (location, value) => {
  if (value === null || value === undefined || value === '') return;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return;
  fieldsScanned += 1;
  aggregate.push(`${location}\n${text}`);
  findings.push(...scanText({
    text,
    location,
    bannedIdentifierHashes,
    bannedTokenHashes,
    strictPublicPaths: true,
    publicIpv4: true,
  }));
};

const scanRecords = (records, prefix, fields, idField = 'id') => {
  for (const record of records) {
    const id = String(record?.[idField] ?? record?.id ?? 'unknown');
    for (const field of fields) scanField(`${prefix}#${id}.${field}`, record?.[field]);
  }
};

const repoData = api(`repos/${owner}/${name}`);
for (const field of ['name', 'full_name', 'description', 'homepage']) {
  scanField(`repository.${field}`, repoData?.[field]);
}

const topics = api(`repos/${owner}/${name}/topics`, { optional: true });
for (const [index, topic] of (topics?.names || []).entries()) scanField(`topics#${index}.name`, topic);

const issues = pagedItems(api(`repos/${owner}/${name}/issues?state=all&per_page=100`, { paginate: true }));
scanRecords(issues, 'issues', ['title', 'body'], 'number');

const issueComments = pagedItems(api(`repos/${owner}/${name}/issues/comments?per_page=100`, { paginate: true }));
scanRecords(issueComments, 'issue-comments', ['body']);

const pullComments = pagedItems(api(`repos/${owner}/${name}/pulls/comments?per_page=100`, { paginate: true }));
scanRecords(pullComments, 'pull-review-comments', ['body', 'path']);

const pulls = issues.filter((item) => item?.pull_request).map((item) => Number(item.number)).filter(Number.isFinite);
for (const pullNumber of pulls) {
  const reviews = pagedItems(api(`repos/${owner}/${name}/pulls/${pullNumber}/reviews?per_page=100`, { paginate: true }));
  scanRecords(reviews, `pull-${pullNumber}-reviews`, ['body']);
}

const commitComments = pagedItems(api(`repos/${owner}/${name}/comments?per_page=100`, { paginate: true }));
scanRecords(commitComments, 'commit-comments', ['body', 'path']);

const releases = pagedItems(api(`repos/${owner}/${name}/releases?per_page=100`, { paginate: true }));
scanRecords(releases, 'releases', ['name', 'tag_name', 'body']);
for (const release of releases) {
  for (const asset of release?.assets || []) {
    scanField(`release#${release.id}.asset#${asset.id}.name`, asset?.name);
    scanField(`release#${release.id}.asset#${asset.id}.label`, asset?.label);
  }
}

const branches = pagedItems(api(`repos/${owner}/${name}/branches?per_page=100`, { paginate: true }));
scanRecords(branches, 'branches', ['name'], 'name');
const tags = pagedItems(api(`repos/${owner}/${name}/tags?per_page=100`, { paginate: true }));
scanRecords(tags, 'tags', ['name'], 'name');
const milestones = pagedItems(api(`repos/${owner}/${name}/milestones?state=all&per_page=100`, { paginate: true, optional: true }));
scanRecords(milestones, 'milestones', ['title', 'description'], 'number');
const labels = pagedItems(api(`repos/${owner}/${name}/labels?per_page=100`, { paginate: true }));
scanRecords(labels, 'labels', ['name', 'description'], 'name');

const workflows = pagedItems(
  api(`repos/${owner}/${name}/actions/workflows?per_page=100`, { paginate: true, optional: true }),
  'workflows',
);
scanRecords(workflows, 'workflows', ['name', 'path']);
const artifacts = pagedItems(
  api(`repos/${owner}/${name}/actions/artifacts?per_page=100`, { paginate: true, optional: true }),
  'artifacts',
);
scanRecords(artifacts, 'artifacts', ['name', 'workflow_run']);

const environments = pagedItems(
  api(`repos/${owner}/${name}/environments?per_page=100`, { paginate: true, optional: true }),
  'environments',
);
scanRecords(environments, 'environments', ['name'], 'name');
const variables = pagedItems(
  api(`repos/${owner}/${name}/actions/variables?per_page=100`, { paginate: true, optional: true }),
  'variables',
);
scanRecords(variables, 'actions-variables', ['name', 'value'], 'name');
const secrets = pagedItems(
  api(`repos/${owner}/${name}/actions/secrets?per_page=100`, { paginate: true, optional: true }),
  'secrets',
);
scanRecords(secrets, 'actions-secrets', ['name'], 'name');

const deployKeys = pagedItems(api(`repos/${owner}/${name}/keys?per_page=100`, { paginate: true, optional: true }));
scanRecords(deployKeys, 'deploy-keys', ['title', 'key']);
const hooks = pagedItems(api(`repos/${owner}/${name}/hooks?per_page=100`, { paginate: true, optional: true }));
for (const hook of hooks) {
  scanField(`hooks#${hook.id}.name`, hook?.name);
  scanField(`hooks#${hook.id}.url`, hook?.config?.url);
}

const discussions = pagedItems(
  api(`repos/${owner}/${name}/discussions?per_page=100`, { paginate: true, optional: true }),
);
scanRecords(discussions, 'discussions', ['title', 'body'], 'number');
for (const discussion of discussions) {
  const comments = pagedItems(api(
    `repos/${owner}/${name}/discussions/${discussion.number}/comments?per_page=100`,
    { paginate: true, optional: true },
  ));
  scanRecords(comments, `discussion-${discussion.number}-comments`, ['body']);
}

const gitleaks = spawnSync(
  'gitleaks',
  ['stdin', '--redact', '--no-banner', '--no-color'],
  {
    input: aggregate.join('\n\n'),
    encoding: 'utf8',
    maxBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
if (gitleaks.error || ![0, 1].includes(gitleaks.status)) {
  throw new Error('gitleaks metadata scan could not complete; details suppressed');
}
if (gitleaks.status === 1) findings.push({
  kind: 'gitleaks-secret-signature',
  location: 'github-metadata',
});

if (findings.length > 0) {
  console.error(`GitHub surface audit failed for ${repo}; ${findings.length} redacted finding(s).`);
  for (const finding of findings.slice(0, 100)) console.error(`  ${formatFinding(finding)}`);
  if (findings.length > 100) console.error(`  ...and ${findings.length - 100} more`);
  process.exit(1);
}

console.log(`GitHub surface audit passed for ${repo} (${fieldsScanned} metadata fields, 0 sensitive-data hits).`);
