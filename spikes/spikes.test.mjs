import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTestKey, buildAssertion, verifyAssertion, b64urlDecode, b64url } from './jwt-sign.mjs';
import { runIntakeBatch, syntheticLines, syntheticGeminiJson } from './parse-50-lines.mjs';
import { validateItem, normaliseLine, sha256Hex, MEDIA_TYPES } from './intake-shared.mjs';
import { syntheticRows, buildBatchUpdateBody, SHEET_COLUMNS } from './serialize-300-rows.mjs';

const dec = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

test('JWT assertion has 3 base64url segments, right header and claims, and verifies', async () => {
  const { pem, publicKey } = await generateTestKey();
  const jwt = await buildAssertion(pem, 'svc@x.iam.gserviceaccount.com', 1700000000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(dec(parts[0]), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(parts[1]), {
    iss: 'svc@x.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1700000000,
    exp: 1700003600,
  });
  assert.equal(await verifyAssertion(jwt, publicKey), true);
});

test('tampering with a claim breaks verification', async () => {
  const { pem, publicKey } = await generateTestKey();
  const [h, c, s] = (await buildAssertion(pem)).split('.');
  const claims = dec(c);
  claims.iss = 'attacker@evil.example';
  assert.equal(await verifyAssertion(`${h}.${b64url(JSON.stringify(claims))}.${s}`, publicKey), false);
});

test('50-line builder yields 50 intake_log rows with unique hashes', async () => {
  const lines = syntheticLines(50);
  const out = await runIntakeBatch(lines, syntheticGeminiJson(50));
  assert.equal(out.params.intake.length, 50);
  assert.equal(new Set(out.params.intake.map((r) => r[0])).size, 50);
  assert.equal(out.statementCount, 150);
});

test('hash ignores case and surrounding whitespace', async () => {
  const a = await sha256Hex(normaliseLine('  Dune (2021)  '));
  const b = await sha256Hex(normaliseLine('dune (2021)'));
  const c = await sha256Hex(normaliseLine('Dune (2022)'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('validator rejects a bad mediaType and accepts every enum value', () => {
  const base = JSON.parse(syntheticGeminiJson(1)).items[0];
  assert.equal(validateItem({ ...base, mediaType: 'Painting' }, 1).ok, false);
  assert.ok(validateItem({ ...base, mediaType: 'Painting' }, 1).errors.includes('mediaType'));
  for (const t of MEDIA_TYPES) assert.equal(validateItem({ ...base, mediaType: t }, 1).ok, true);
});

test('300-row serialiser gives 300 data rows per tab with the expected column count', () => {
  const body = JSON.parse(JSON.stringify(buildBatchUpdateBody(syntheticRows(300))));
  assert.deepEqual(body.data.map((d) => d.range.split('!')[0]), ['Library_Archive', 'Active_Queue', 'Curated_Lists']);
  for (const tab of body.data) {
    assert.equal(tab.values.length, 301); // header + 300
    for (const row of tab.values) assert.equal(row.length, SHEET_COLUMNS.length);
  }
});
