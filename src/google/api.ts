export class SubrequestBudgetError extends Error {
  constructor(limit: number) {
    super(`Subrequest budget exceeded (limit ${limit})`);
    this.name = "SubrequestBudgetError";
  }
}

export interface SubrequestBudget {
  used: number;
  readonly limit: number;
  take(): void;
}

export function createSubrequestBudget(limit = 50): SubrequestBudget {
  const budget: SubrequestBudget = {
    used: 0,
    limit,
    take() {
      if (budget.used + 1 > limit) throw new SubrequestBudgetError(limit);
      budget.used += 1;
    },
  };
  return budget;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly googleStatus?: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export interface ApiOpts {
  token: string;
  fetchImpl?: typeof fetch;
  budget?: SubrequestBudget;
}

export async function googleRequest(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  opts: ApiOpts,
): Promise<unknown> {
  opts.budget?.take();
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await (opts.fetchImpl ?? fetch)(url, init);
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Empty or non-JSON body.
  }
  if (!res.ok) {
    const err = (payload as { error?: { message?: string; status?: string } } | null)?.error;
    throw new GoogleApiError(
      `Google API ${method} failed: HTTP ${res.status}${err?.status ? ` ${err.status}` : ""}${err?.message ? `: ${err.message}` : ""}`,
      res.status,
      err?.status,
    );
  }
  return payload;
}

// ---- Docs ----

export interface DocParagraph {
  startIndex: number;
  endIndex: number;
  text: string;
}

export interface DocSnapshot {
  revisionId: string;
  endIndex: number;
  paragraphs: DocParagraph[];
}

interface RawDoc {
  revisionId?: string;
  body?: {
    content?: {
      startIndex?: number;
      endIndex?: number;
      paragraph?: { elements?: { textRun?: { content?: string } }[] };
    }[];
  };
}

const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export async function getDocument(docId: string, opts: ApiOpts): Promise<DocSnapshot> {
  const raw = (await googleRequest("GET", `${DOCS}/${encodeURIComponent(docId)}`, undefined, opts)) as RawDoc;
  const content = raw.body?.content ?? [];
  const paragraphs: DocParagraph[] = [];
  for (const el of content) {
    if (!el.paragraph) continue;
    paragraphs.push({
      startIndex: el.startIndex ?? 0,
      endIndex: el.endIndex ?? 0,
      text: (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join(""),
    });
  }
  return {
    revisionId: raw.revisionId ?? "",
    endIndex: content.length ? (content[content.length - 1]!.endIndex ?? 0) : 0,
    paragraphs,
  };
}

export type DeleteResult = { ok: true } | { ok: false; status: 400 };

/** A 400 (stale targetRevisionId or bad range) means abort the clear safely, so it is returned, not thrown. */
export async function deleteContentRange(
  docId: string,
  range: { startIndex: number; endIndex: number; targetRevisionId: string },
  opts: ApiOpts,
): Promise<DeleteResult> {
  return deleteContentRanges(
    docId,
    [{ startIndex: range.startIndex, endIndex: range.endIndex }],
    range.targetRevisionId,
    opts,
  );
}

/** Deletes several ranges in one batchUpdate, highest first so earlier indexes stay valid. */
export async function deleteContentRanges(
  docId: string,
  ranges: { startIndex: number; endIndex: number }[],
  targetRevisionId: string,
  opts: ApiOpts,
): Promise<DeleteResult> {
  const requests = [...ranges]
    .sort((a, b) => b.startIndex - a.startIndex)
    .map((r) => ({ deleteContentRange: { range: { startIndex: r.startIndex, endIndex: r.endIndex } } }));
  try {
    await googleRequest(
      "POST",
      `${DOCS}/${encodeURIComponent(docId)}:batchUpdate`,
      { requests, writeControl: { targetRevisionId } },
      opts,
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof GoogleApiError && e.status === 400) return { ok: false, status: 400 };
    throw e;
  }
}

// ---- Sheets ----

export type CellValue = string | number | boolean | null;

export async function valuesBatchClear(sheetId: string, ranges: string[], opts: ApiOpts): Promise<unknown> {
  return googleRequest("POST", `${SHEETS}/${encodeURIComponent(sheetId)}/values:batchClear`, { ranges }, opts);
}

export async function valuesBatchUpdate(
  sheetId: string,
  data: { range: string; values: CellValue[][] }[],
  opts: ApiOpts,
): Promise<unknown> {
  return googleRequest(
    "POST",
    `${SHEETS}/${encodeURIComponent(sheetId)}/values:batchUpdate`,
    { valueInputOption: "RAW", data },
    opts,
  );
}
