import { createSubrequestBudget, getDocument } from "../google/api";
import { getGoogleAccessToken } from "../google/token";
import { GeminiError } from "./gemini";
import type { MediaType } from "./gemini";
import { MAX_LINES_PER_RUN } from "./lines";
import { parseLines } from "./parse";
import type { SweepDeps } from "./doc-sweep";

export interface TestParseLine {
  line: string;
  ok: boolean;
  title?: string;
  mediaType?: MediaType;
  status?: "Backlog" | "Completed";
  reason?: string;
}

export type TestParseResult =
  | { skipped: "no-inbox-doc" | "nothing-to-do" }
  | { lines: TestParseLine[]; diag?: string; degraded?: boolean };

const UNREADABLE = "no parser could read this line";

/**
 * Dry run of a sweep: reads the Inbox Doc and runs the parsers, but never writes to D1 and never
 * edits the Doc. Same line selection and cap as sweepInboxDoc.
 */
export async function testParseInbox(deps: SweepDeps): Promise<TestParseResult> {
  const docId = deps.env.INBOX_DOC_ID;
  if (!docId) return { skipped: "no-inbox-doc" };

  const budget = createSubrequestBudget();
  const token = await getGoogleAccessToken({ db: deps.db, env: deps.env, fetchImpl: deps.fetchImpl, budget });
  const doc = await getDocument(docId, { token, fetchImpl: deps.fetchImpl, budget });

  const texts = doc.paragraphs
    .slice(1)
    .map((p) => p.text)
    .filter((t) => {
      const s = t.trim();
      return s !== "" && !s.startsWith("#");
    })
    .slice(0, MAX_LINES_PER_RUN);
  if (texts.length === 0) return { skipped: "nothing-to-do" };

  try {
    const parsed = await parseLines({ lines: texts, env: deps.env, fetchImpl: deps.fetchImpl, budget });
    const byIndex = new Map(parsed.items.map((it) => [it.lineIndex, it]));
    const lines: TestParseLine[] = texts.map((line, i) => {
      const it = byIndex.get(i);
      if (!it) return { line, ok: false, reason: UNREADABLE };
      return {
        line,
        ok: true,
        title: it.title,
        mediaType: it.mediaType,
        status: it.isAlreadyConsumed ? "Completed" : "Backlog",
      };
    });
    const out: { lines: TestParseLine[]; diag?: string; degraded?: boolean } = { lines };
    if (parsed.diag) out.diag = parsed.diag;
    if (parsed.degraded) out.degraded = true;
    return out;
  } catch (e) {
    if (!(e instanceof GeminiError)) throw e;
    const reason = `${e.message}${e.detail ? ` | ${e.detail}` : ""}`;
    return { lines: texts.map((line) => ({ line, ok: false, reason })), diag: `FAILED: ${reason}`, degraded: true };
  }
}
