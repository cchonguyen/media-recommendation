// Spike 1: cost of a Google service-account JWT mint (token-cache miss path).
import { coldAndWarm, printTable, f, isMain } from './measure.mjs';

const enc = new TextEncoder();
const SCOPE = 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets';
const AUD = 'https://oauth2.googleapis.com/token';

export function b64url(bytes) {
  const u8 = typeof bytes === 'string' ? enc.encode(bytes) : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function pemToPkcs8(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0)).buffer;
}

export function pkcs8ToPem(buf) {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  const lines = btoa(bin).match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

/** Throwaway key pair, generated at runtime, never written to disk. */
export async function generateTestKey() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  return { pem: pkcs8ToPem(pkcs8), publicKey: kp.publicKey };
}

/** What the Worker does on a token-cache miss, minus the network exchange. */
export async function buildAssertion(pem, email = 'svc@example-project.iam.gserviceaccount.com', nowSec = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: AUD, iat: nowSec, exp: nowSec + 3600 }));
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

export async function verifyAssertion(assertion, publicKey) {
  const [h, c, s] = assertion.split('.');
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s), enc.encode(`${h}.${c}`));
}

async function main() {
  const { pem, publicKey } = await generateTestKey();
  const r = await coldAndWarm(() => buildAssertion(pem), 200);
  const ok = await verifyAssertion(await buildAssertion(pem), publicKey);
  console.log(`node ${process.version}  v8 ${process.versions.v8}  verify=${ok}`);
  const row = (label, s) => ({ run: label, cpu_mean: f(s.mean), cpu_p50: f(s.p50), cpu_p95: f(s.p95), cpu_max: f(s.max) });
  printTable('JWT sign (importKey + sign), CPU ms (user+system); budget 10 ms per invocation', [
    { run: 'cold (1st call)', cpu_mean: f(r.cold.cpuMs), cpu_p50: '-', cpu_p95: '-', cpu_max: '-' },
    row('warm x200', r.warmCpu),
  ]);
  printTable('Same runs, wall ms (performance.now)', [
    { run: 'cold', wall_ms: f(r.cold.wallMs) },
    { run: 'warm mean', wall_ms: f(r.warmWall.mean) },
    { run: 'warm p50', wall_ms: f(r.warmWall.p50) },
    { run: 'warm p95', wall_ms: f(r.warmWall.p95) },
    { run: 'warm max', wall_ms: f(r.warmWall.max) },
  ]);
  console.log('\nNote: key generation ran before the cold call, so crypto init is already paid. RSA sign may run on a libuv threadpool thread in Node; process.cpuUsage() counts all threads of the process, wall counts elapsed time.');
}

if (isMain(import.meta.url)) await main();

