import { describe, expect, it } from "vitest";
import {
  GoogleApiError,
  SubrequestBudgetError,
  createSubrequestBudget,
  deleteContentRange,
  getDocument,
  valuesBatchClear,
  valuesBatchUpdate,
} from "./api";
import { base64url, pemToPkcs8, signServiceAccountJwt } from "./jwt";
import {
  GoogleAuthError,
  getCachedValue,
  getGoogleAccessToken,
  setCachedValue,
} from "./token";
import {
  base64urlDecode,
  createFakeFetch,
  createTestD1,
  createTestDb,
  generateTestServiceAccount,
  jsonResponse,
} from "./test-helpers";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const dec = new TextDecoder();
const enc = new TextEncoder();
const NOW = 1_800_000_000;

describe("jwt", () => {
  it("signs a three-segment RS256 JWT that verifies and fails on tamper", async () => {
    const sa = await generateTestServiceAccount();
    const jwt = await signServiceAccountJwt({
      email: sa.email,
      privateKeyPem: sa.privateKeyPem,
      scopes: ["a", "b"],
      nowSeconds: NOW,
    });
    const [h, c, s] = jwt.split(".");
    expect(jwt.split(".")).toHaveLength(3);
    expect(JSON.parse(dec.decode(base64urlDecode(h!)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(dec.decode(base64urlDecode(c!)))).toEqual({
      iss: sa.email,
      scope: "a b",
      aud: TOKEN_URL,
      iat: NOW,
      exp: NOW + 3600,
    });
    const verify = (input: string) =>
      crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, base64urlDecode(s!), enc.encode(input));
    expect(await verify(`${h}.${c}`)).toBe(true);
    expect(await verify(`${h}.${c}x`)).toBe(false);
  });

  it("honours a custom audience", async () => {
    const sa = await generateTestServiceAccount();
    const jwt = await signServiceAccountJwt({
      email: sa.email, privateKeyPem: sa.privateKeyPem, scopes: [], nowSeconds: NOW, audience: "https://x.test/t",
    });
    expect(JSON.parse(dec.decode(base64urlDecode(jwt.split(".")[1]!))).aud).toBe("https://x.test/t");
  });

  it("imports PEM with literal \\n sequences and with real newlines", async () => {
    const sa = await generateTestServiceAccount();
    const literal = sa.privateKeyPem.trim().replaceAll("\n", "\\n");
    expect(literal).not.toContain("\n");
    expect(new Uint8Array(pemToPkcs8(literal))).toEqual(new Uint8Array(pemToPkcs8(sa.privateKeyPem)));
    for (const pem of [literal, sa.privateKeyPem]) {
      await expect(
        signServiceAccountJwt({ email: sa.email, privateKeyPem: pem, scopes: [], nowSeconds: NOW }),
      ).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    }
  });

  it("throws on a garbage key without leaking key text", async () => {
    const secret = "SUPERSECRETKEYTEXT";
    for (const pem of [
      `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
      `-----BEGIN PRIVATE KEY-----\n${btoa(secret)}\n-----END PRIVATE KEY-----`,
    ]) {
      const err = await signServiceAccountJwt({ email: "e", privateKeyPem: pem, scopes: [], nowSeconds: NOW }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Malformed private key/);
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).not.toContain(btoa(secret));
    }
  });

  it("base64url has no padding or unsafe chars", () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(base64url("a")).toBe("YQ");
  });
});

describe("token cache and exchange", () => {
  const setup = async (handler?: Parameters<typeof createFakeFetch>[0][string]) => {
    const sa = await generateTestServiceAccount();
    const db = createTestDb();
    const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: sa.email, GOOGLE_PRIVATE_KEY: sa.privateKeyPem };
    const fake = createFakeFetch({
      [TOKEN_URL]: handler ?? (() => jsonResponse({ access_token: "tok-abc", expires_in: 3599 })),
    });
    return { db, env, ...fake };
  };

  it("generic cache returns only unexpired values and upserts", async () => {
    const db = createTestDb();
    expect(await getCachedValue(db, "k", 100)).toBeNull();
    await setCachedValue(db, "k", "v1", 200);
    expect(await getCachedValue(db, "k", 100)).toBe("v1");
    expect(await getCachedValue(db, "k", 200)).toBeNull();
    await setCachedValue(db, "k", "v2", 300);
    expect(await getCachedValue(db, "k", 250)).toBe("v2");
  });

  it("mints on a miss, caches with TTL expires_in - 300 (3299s), then hits the cache", async () => {
    const { db, env, fetchImpl, calls } = await setup();
    const budget = createSubrequestBudget();
    expect(await getGoogleAccessToken({ db, env, fetchImpl, nowSeconds: NOW, budget })).toBe("tok-abc");
    expect(budget.used).toBe(1);
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0]!.body!);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")!.split(".")).toHaveLength(3);
    expect(await getCachedValue(db, "google_access_token", NOW + 3298)).toBe("tok-abc");
    expect(await getCachedValue(db, "google_access_token", NOW + 3299)).toBeNull();

    expect(await getGoogleAccessToken({ db, env, fetchImpl, nowSeconds: NOW + 10, budget })).toBe("tok-abc");
    expect(calls).toHaveLength(1);
    expect(budget.used).toBe(1);
  });

  it("caps the TTL at expires_in - 300 for short-lived tokens", async () => {
    const { db, env, fetchImpl } = await setup(() => jsonResponse({ access_token: "short", expires_in: 1000 }));
    await getGoogleAccessToken({ db, env, fetchImpl, nowSeconds: NOW });
    expect(await getCachedValue(db, "google_access_token", NOW + 699)).toBe("short");
    expect(await getCachedValue(db, "google_access_token", NOW + 700)).toBeNull();
  });

  it("re-mints when the cached row has expired", async () => {
    const { db, env, fetchImpl, calls } = await setup();
    await setCachedValue(db, "google_access_token", "old", NOW - 1);
    expect(await getGoogleAccessToken({ db, env, fetchImpl, nowSeconds: NOW })).toBe("tok-abc");
    expect(calls).toHaveLength(1);
    expect(await getCachedValue(db, "google_access_token", NOW)).toBe("tok-abc");
  });

  it("throws GoogleAuthError with status and code only on non-2xx", async () => {
    const { db, env, fetchImpl, calls } = await setup(() =>
      jsonResponse({ error: "invalid_grant", error_description: "Invalid JWT" }, 400),
    );
    const err = await getGoogleAccessToken({ db, env, fetchImpl, nowSeconds: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    const e = err as GoogleAuthError;
    expect(e.status).toBe(400);
    expect(e.code).toBe("invalid_grant");
    const assertion = new URLSearchParams(calls[0]!.body!).get("assertion")!;
    expect(e.message).not.toContain(assertion);
    expect(e.message).not.toContain("BEGIN");
    expect(e.message).not.toContain("Invalid JWT");
  });

  it("throws GoogleAuthError naming a missing env var", async () => {
    const { db, env, fetchImpl } = await setup();
    await expect(
      getGoogleAccessToken({ db, env: { ...env, GOOGLE_PRIVATE_KEY: undefined }, fetchImpl, nowSeconds: NOW }),
    ).rejects.toThrow(/GOOGLE_PRIVATE_KEY/);
    await expect(
      getGoogleAccessToken({ db, env: { GOOGLE_PRIVATE_KEY: env.GOOGLE_PRIVATE_KEY }, fetchImpl, nowSeconds: NOW }),
    ).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe("docs", () => {
  const DOC = "https://docs.googleapis.com/v1/documents/doc%2F1";
  const realistic = {
    documentId: "doc/1",
    revisionId: "rev-42",
    body: {
      content: [
        { endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 12, paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: "Inbox list\n" } }] } },
        {
          startIndex: 12,
          endIndex: 30,
          paragraph: {
            elements: [
              { startIndex: 12, endIndex: 18, textRun: { content: "Dune, " } },
              { startIndex: 18, endIndex: 30, textRun: { content: "Arrival 2016\n" } },
            ],
          },
        },
        { startIndex: 30, endIndex: 41, paragraph: { elements: [{ startIndex: 30, endIndex: 41, textRun: { content: "Hades game\n" } }] } },
      ],
    },
  };

  it("getDocument parses paragraphs, indexes and revisionId", async () => {
    const { fetchImpl, calls } = createFakeFetch({ [DOC]: jsonResponse(realistic) });
    const doc = await getDocument("doc/1", { token: "t", fetchImpl });
    expect(doc.revisionId).toBe("rev-42");
    expect(doc.endIndex).toBe(41);
    expect(doc.paragraphs).toEqual([
      { startIndex: 1, endIndex: 12, text: "Inbox list\n" },
      { startIndex: 12, endIndex: 30, text: "Dune, Arrival 2016\n" },
      { startIndex: 30, endIndex: 41, text: "Hades game\n" },
    ]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe("Bearer t");
  });

  it("deleteContentRange sends writeControl and range, returns ok", async () => {
    const url = `${DOC}:batchUpdate`;
    const { fetchImpl, calls } = createFakeFetch({ [url]: jsonResponse({}) });
    const r = await deleteContentRange("doc/1", { startIndex: 12, endIndex: 40, targetRevisionId: "rev-42" }, { token: "t", fetchImpl });
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      requests: [{ deleteContentRange: { range: { startIndex: 12, endIndex: 40 } } }],
      writeControl: { targetRevisionId: "rev-42" },
    });
  });

  it("returns { ok:false, status:400 } on 400 and throws on 500", async () => {
    const url = `${DOC}:batchUpdate`;
    const range = { startIndex: 1, endIndex: 2, targetRevisionId: "r" };
    const bad = createFakeFetch({ [url]: jsonResponse({ error: { message: "stale revision", status: "FAILED_PRECONDITION" } }, 400) });
    expect(await deleteContentRange("doc/1", range, { token: "t", fetchImpl: bad.fetchImpl })).toEqual({ ok: false, status: 400 });
    const boom = createFakeFetch({ [url]: jsonResponse({ error: { message: "backend", status: "INTERNAL" } }, 500) });
    const err = await deleteContentRange("doc/1", range, { token: "t", fetchImpl: boom.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).status).toBe(500);
    expect((err as GoogleApiError).googleStatus).toBe("INTERNAL");
  });
});

describe("sheets", () => {
  const base = "https://sheets.googleapis.com/v4/spreadsheets/sheet%2Fid";

  it("valuesBatchClear posts ranges", async () => {
    const { fetchImpl, calls } = createFakeFetch({ [`${base}/values:batchClear`]: jsonResponse({}) });
    await valuesBatchClear("sheet/id", ["Movies!A2:Z", "TV!A2:Z"], { token: "t", fetchImpl });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ranges: ["Movies!A2:Z", "TV!A2:Z"] });
  });

  it("valuesBatchUpdate posts RAW data", async () => {
    const { fetchImpl, calls } = createFakeFetch({ [`${base}/values:batchUpdate`]: jsonResponse({}) });
    const data = [{ range: "Movies!A2", values: [["Dune", 2021, true, null]] }];
    await valuesBatchUpdate("sheet/id", data, { token: "t", fetchImpl });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ valueInputOption: "RAW", data });
  });
});

describe("subrequest budget", () => {
  it("throws on the 51st call", () => {
    const b = createSubrequestBudget();
    for (let i = 0; i < 50; i++) b.take();
    expect(b.used).toBe(50);
    expect(() => b.take()).toThrow(SubrequestBudgetError);
    expect(b.used).toBe(50);
  });

  it("is enforced before the network call", async () => {
    const budget = createSubrequestBudget(1);
    const { fetchImpl, calls } = createFakeFetch({
      "https://sheets.googleapis.com/v4/spreadsheets/s/values:batchClear": jsonResponse({}),
    });
    await valuesBatchClear("s", [], { token: "t", fetchImpl, budget });
    await expect(valuesBatchClear("s", [], { token: "t", fetchImpl, budget })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(calls).toHaveLength(1);
  });
});

describe("hygiene", () => {
  it("never leaks the bearer token in errors", async () => {
    const token = "ya29.SECRET-BEARER";
    const url = "https://sheets.googleapis.com/v4/spreadsheets/s/values:batchClear";
    const { fetchImpl } = createFakeFetch({
      [url]: jsonResponse({ error: { message: "denied", status: "PERMISSION_DENIED" } }, 403),
    });
    const logs: string[] = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      const err = await valuesBatchClear("s", [], { token, fetchImpl }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as Error).message).not.toContain(token);
      expect((err as Error).message).not.toMatch(/bearer/i);
      expect(JSON.stringify(err)).not.toContain(token);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    expect(logs.join("\n")).not.toContain(token);
  });

  it("createTestD1 is isolated per call", async () => {
    const a = createTestDb(createTestD1());
    const b = createTestDb(createTestD1());
    await setCachedValue(a, "k", "v", 10);
    expect(await getCachedValue(b, "k", 0)).toBeNull();
  });
});
