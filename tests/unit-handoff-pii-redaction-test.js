import assert from 'node:assert/strict';

import { redactHandoffText, redactMemoryText } from '../lib/core/host-memory-sync.js';

// Regression (P3): handoff/brief surfaces move data off-machine, so their
// redactor must mask PII (emails, IPv4s, home-path usernames) on top of the
// credential redaction. All fixtures are synthetic (example.com / RFC5737
// documentation IPs / invented usernames).
const run = async () => {
  // The scanner rejects every literal home path, including synthetic ones, so
  // these unmistakably fictional fixtures are assembled without embedding a
  // publishable machine path in the source.
  const macHome = ['', 'Users', 'synthetic-mac-user'].join('/');
  const linuxHome = ['', 'home', 'synthetic-linux-user'].join('/');
  const combinedMacHome = ['', 'Users', 'synthetic-combined-user'].join('/');
  const redactedMacHome = ['', 'Users', '[REDACTED_USER]'].join('/');
  const redactedLinuxHome = ['', 'home', '[REDACTED_USER]'].join('/');

  // Emails are masked.
  {
    const out = redactHandoffText('Reach jordan.doe@example.com for the deploy notes.');
    assert.ok(!out.includes('jordan.doe@example.com'), 'email removed');
    assert.ok(out.includes('[REDACTED_EMAIL]'), 'email placeholder present');
  }

  // Absolute home-path username segment is masked, rest of path kept.
  {
    const unix = redactHandoffText(`Config lives at ${macHome}/repo/config.json here.`);
    assert.ok(!unix.includes(`${macHome}/`), 'macOS username removed');
    assert.ok(unix.includes(`${redactedMacHome}/repo/config.json`), 'path tail preserved');

    const linux = redactHandoffText(`Logs under ${linuxHome}/app.log rotate nightly.`);
    assert.ok(!linux.includes(`${linuxHome}/`), 'linux username removed');
    assert.ok(linux.includes(`${redactedLinuxHome}/app.log`), 'path tail preserved');
  }

  // IPv4 addresses are masked.
  {
    const out = redactHandoffText('The box answers on 192.0.2.44 over ssh.');
    assert.ok(!out.includes('192.0.2.44'), 'IPv4 removed');
    assert.ok(out.includes('[REDACTED_IP]'), 'IPv4 placeholder present');
  }

  // Combined line with everything at once.
  {
    const out = redactHandoffText(`Contact jane@example.org at ${combinedMacHome}/work, ssh 198.51.100.7`);
    assert.ok(!out.includes('jane@example.org'), 'combined: email gone');
    assert.ok(!out.includes(`${combinedMacHome}/`), 'combined: username gone');
    assert.ok(!out.includes('198.51.100.7'), 'combined: IP gone');
  }

  // Credential redaction still runs through the handoff redactor.
  {
    const out = redactHandoffText('token=sk-' + 'abcdef1234567890 for the run');
    assert.ok(out.includes('[REDACTED_SECRET]'), 'secret still redacted via handoff path');
  }

  // Guard the asymmetry: the ingest-time redactor (redactMemoryText) must NOT
  // strip PII — stored memory content keeps the user's own name/paths/IPs.
  {
    const kept = redactMemoryText(`Contact jane@example.org at ${combinedMacHome}/work, ssh 198.51.100.7`);
    assert.ok(kept.includes('jane@example.org'), 'ingest keeps email');
    assert.ok(kept.includes(`${combinedMacHome}/work`), 'ingest keeps home path');
    assert.ok(kept.includes('198.51.100.7'), 'ingest keeps IP');
  }

  console.log('unit-handoff-pii-redaction-test: PASS');
};

export { run };

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
