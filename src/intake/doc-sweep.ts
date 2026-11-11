import { createSubrequestBudget, deleteContentRange, getDocument } from "../google/api";
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
  | { ingest: IngestResult; cleared: boolean; remainingInDoc: number };

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

  const startIndex = body[0]!.startIndex;
  // The final newline of a Doc can never be deleted.
  const endIndex = capped ? takenParas[takenParas.length - 1]!.endIndex : doc.endIndex - 1;
  const remainingInDoc = candidates.length - takenParas.length;

  let cleared = false;
  if (endIndex > startIndex) {
    const res = await deleteContentRange(
      docId,
      { startIndex, endIndex, targetRevisionId: doc.revisionId },
      opts,
    );
    cleared = res.ok;
  }
  return { ingest, cleared, remainingInDoc };
}
