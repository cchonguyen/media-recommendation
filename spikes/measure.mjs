// Shared measurement helpers for the Slice 0 spikes. Node built-ins only.
import { performance } from 'node:perf_hooks';

/** Run fn once; return CPU (user+system) and wall time in ms. */
export async function measureOnce(fn) {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  const result = await fn();
  const wall = performance.now() - w0;
  const c = process.cpuUsage(c0);
  return { cpuMs: (c.user + c.system) / 1000, wallMs: wall, result };
}

export function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], n: s.length };
}

/** Cold = first call in this process; warm = `runs` further calls. */
export async function coldAndWarm(fn, runs = 200) {
  const cold = await measureOnce(fn);
  const warmCpu = [];
  const warmWall = [];
  for (let i = 0; i < runs; i++) {
    const m = await measureOnce(fn);
    warmCpu.push(m.cpuMs);
    warmWall.push(m.wallMs);
  }
  return { cold, warmCpu: stats(warmCpu), warmWall: stats(warmWall) };
}

export const f = (n) => n.toFixed(3);

export function printTable(title, rows) {
  console.log(`\n${title}`);
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(w[i])).join(' | ');
  console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(w.map((x) => '-'.repeat(x)).join('-|-'));
  rows.forEach((r) => console.log(line(r)));
}

export function isMain(metaUrl) {
  return process.argv[1] && new URL(metaUrl).pathname === process.argv[1];
}
