// Spike 2: CPU cost of the intake work for a 50-line batch, no network.
import { coldAndWarm, printTable, f, isMain } from './measure.mjs';
import { syntheticLines, syntheticGeminiJson, runIntakeBatch } from './intake-shared.mjs';

export { runIntakeBatch, syntheticLines, syntheticGeminiJson };

async function main() {
  const lines = syntheticLines(50);
  const json = syntheticGeminiJson(50);
  const r = await coldAndWarm(() => runIntakeBatch(lines, json), 200);
  const probe = r.cold.result;
  console.log(`node ${process.version}  v8 ${process.versions.v8}`);
  console.log(`gemini json: ${(json.length / 1024).toFixed(1)} KB, valid items: ${probe.validCount}, D1 statements: ${probe.statementCount}`);
  printTable('50-line intake CPU work, ms (user+system); budget 10 ms per invocation', [
    { run: 'cold (1st call)', mean: f(r.cold.cpuMs), p50: '-', p95: '-', max: '-' },
    { run: 'warm x200', mean: f(r.warmCpu.mean), p50: f(r.warmCpu.p50), p95: f(r.warmCpu.p95), max: f(r.warmCpu.max) },
  ]);
}

if (isMain(import.meta.url)) await main();
