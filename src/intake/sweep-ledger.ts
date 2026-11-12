import { desc, lt, sql } from "drizzle-orm";
import { sweepRuns } from "../db/schema";
import type { NewSweepRun } from "../db/schema";
import { GoogleApiError, SubrequestBudgetError } from "../google/api";
import { GoogleAuthError } from "../google/token";
import type { Db } from "../google/token";
import { GeminiError } from "./gemini";
import type { SweepDeps, SweepResult } from "./doc-sweep";

export const SWEEP_RUNS_KEPT = 200;
const MAX_TEXT = 1500;

export type SweepTrigger = "cron" | "button";

/** Which part of the sweep failed, from the error type alone. */
export function classifyStage(e: unknown): string {
  if (e instanceof GeminiError) return "parse";
  if (e instanceof GoogleAuthError) return "google-auth";
  if (e instanceof GoogleApiError) return "google-docs";
  if (e instanceof SubrequestBudgetError) return "budget";
  return "unknown";
}

function describeError(e: unknown): string {
  if (e instanceof GeminiError) return `${e.message}${e.detail ? ` | ${e.detail}` : ""}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Turns a finished sweep into a ledger row. Skipped sweeps (nothing to do) return null and are not recorded. */
export function rowFromResult(result: SweepResult, base: Pick<NewSweepRun, "startedAt" | "durationMs" | "trigger">): NewSweepRun | null {
  if ("skipped" in result) return null;
  const { ingest } = result;
  const clean = result.cleared && result.keptInDoc === 0 && ingest.rejected === 0;
  return {
    ...base,
    outcome: clean ? "ok" : "partial",
    stage: clean ? null : result.cleared ? "parse" : "clear-doc",
    linesSeen: ingest.accepted + ingest.unparsedLines.length + ingest.skippedDuplicates,
    created: ingest.created,
    merged: ingest.merged,
    duplicates: ingest.skippedDuplicates,
    keptInDoc: result.keptInDoc,
    rejected: ingest.rejected,
    cleared: result.cleared,
    error: null,
    diag: ingest.diag?.slice(0, MAX_TEXT) ?? null,
  };
}

export function rowFromError(e: unknown, base: Pick<NewSweepRun, "startedAt" | "durationMs" | "trigger">): NewSweepRun {
  return {
    ...base,
    outcome: "failed",
    stage: classifyStage(e),
    error: describeError(e).slice(0, MAX_TEXT),
    diag: null,
  };
}

/** Writes one row and prunes old ones in a single batch. Never throws: telemetry must not fail a sweep. */
export async function recordSweepRun(db: Db, row: NewSweepRun): Promise<void> {
  try {
    await db.batch([
      db.insert(sweepRuns).values(row),
      db.delete(sweepRuns).where(
        lt(sweepRuns.id, sql`(SELECT MIN(id) FROM (SELECT id FROM ${sweepRuns} ORDER BY id DESC LIMIT ${SWEEP_RUNS_KEPT}))`),
      ),
    ]);
  } catch (err) {
    console.error("sweep ledger write failed", err instanceof Error ? err.message : "unknown");
  }
}

export async function lastSweepRuns(db: Db, limit = 20) {
  return db.select().from(sweepRuns).orderBy(desc(sweepRuns.id)).limit(limit);
}

/**
 * Runs a sweep, records the outcome in the ledger and emits one JSON log line.
 * The sweep's own result or error is returned or rethrown unchanged.
 */
export async function runLoggedSweep(
  deps: SweepDeps,
  trigger: SweepTrigger,
  sweep: (deps: SweepDeps) => Promise<SweepResult>,
): Promise<SweepResult> {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const base = () => ({ startedAt, durationMs: Date.now() - t0, trigger });
  let result: SweepResult;
  try {
    result = await sweep(deps);
  } catch (e) {
    const row = rowFromError(e, base());
    console.error(JSON.stringify({ event: "inbox_sweep", ...row }));
    await recordSweepRun(deps.db, row);
    throw e;
  }
  const row = rowFromResult(result, base());
  if (row) {
    (row.outcome === "ok" ? console.log : console.warn)(JSON.stringify({ event: "inbox_sweep", ...row }));
    await recordSweepRun(deps.db, row);
  }
  return result;
}
