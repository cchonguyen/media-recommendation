import { createSubrequestBudget, deleteContentRanges, getDocument } from "../google/api";
import { getGoogleAccessToken } from "../google/token";
import type { Db } from "../google/token";
import { MAX_LINES_PER_RUN } from "./lines";
import { ingestRawLines } from "./ingest";
import type { IngestResult } from "./ingest";
import type { IntakeEnv } from "./types";

export interface SweepDeps {
  db: Db;
  env: IntakeEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type SweepResult =
  | { skipped: "no-inbox-doc" }
  | { skipped: "nothing-to-do"; remainingInDoc: 0 }
  | { ingest: IngestResult; cleared: boolean; remainingInDoc: number; keptInDoc: number };

export async function sweepInboxDoc(deps: SweepDeps): Promise<SweepResult> {
  const docId = deps.env.INBOX_DOC_ID;
  if (!docId) return { skipped: "no-inbox-doc" };

  const budget = createSubrequestBudget();
  const token = await getGoogleAccessToken({ db: deps.db, env: deps.env, fetchImpl: deps.fetchImpl, budget });
  const opts = { token, fetchImpl: deps.fetchImpl, budget };
  const doc = await getDocument(docId, opts);

  // Paragraph 1 is a permanent header: never read, never deleted.
  const body = doc.paragraphs.slice(1);
  if (body.length === 0) return { skipped: "nothing-to-do", remainingInDoc: 0 };
  const candidates = body.filter((p) => {
    const t = p.text.trim();
    return t !== "" && !t.startsWith("#");
  });
  if (candidates.length === 0) return { skipped: "nothing-to-do", remainingInDoc: 0 };

  const takenParas = candidates.slice(0, MAX_LINES_PER_RUN);
  const capped = candidates.length > takenParas.length;
  const ingest = await ingestRawLines(
    { db: deps.db, env: deps.env, fetchImpl: deps.fetchImpl, budget, now: deps.now },
    takenParas.map((p) => p.text),
    "gdoc",
  );

  // Lines the parser could not read stay in the Doc and are not logged in intake_log, so nothing is lost.
  const keep = new Set(ingest.unparsedLines.map((l) => l.trim()));
  const taken = new Set<unknown>(takenParas);
  const lastTaken = takenParas[takenParas.length - 1]!;
  const scope = capped ? body.slice(0, body.indexOf(lastTaken) + 1) : body;
  const ranges: { startIndex: number; endIndex: number }[] = [];
  let run: { startIndex: number; endIndex: number } | null = null;
  for (const p of scope) {
    const kept = taken.has(p) && keep.has(p.text.trim());
    if (kept) {
      if (run) ranges.push(run);
      run = null;
    } else if (run) {
      run.endIndex = p.endIndex;
    } else {
      run = { startIndex: p.startIndex, endIndex: p.endIndex };
    }
  }
  if (run) ranges.push(run);
  // The final newline of a Doc can never be deleted.
  const docEnd = doc.endIndex - 1;
  const clean = ranges
    .map((r) => ({ startIndex: r.startIndex, endIndex: Math.min(r.endIndex, docEnd) }))
    .filter((r) => r.endIndex > r.startIndex);
  const remainingInDoc = candidates.length - takenParas.length;

  let cleared = false;
  if (clean.length > 0) {
    const res = await deleteContentRanges(docId, clean, doc.revisionId, opts);
    cleared = res.ok;
  } else {
    cleared = keep.size === 0;
  }
  return { ingest, cleared, remainingInDoc, keptInDoc: ingest.unparsedLines.length };
}
