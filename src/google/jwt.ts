const enc = new TextEncoder();

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function base64url(input: Uint8Array | ArrayBuffer | string): string {
  const u8 = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Accepts real newlines or literal two-character `\n` sequences (common in stored secrets). */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replaceAll("\\n", "\n")
    .replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  let bin: string;
  try {
    bin = atob(body);
  } catch {
    throw new Error("Malformed private key: not valid base64 PEM");
  }
  if (bin.length === 0) throw new Error("Malformed private key: empty PEM body");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export interface SignJwtInput {
  email: string;
  privateKeyPem: string;
  scopes: string[];
  nowSeconds: number;
  audience?: string;
}

export async function signServiceAccountJwt(input: SignJwtInput): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(input.privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (e) {
    // Never include key material in the message.
    if (e instanceof Error && e.message.startsWith("Malformed private key")) throw e;
    throw new Error("Malformed private key: could not import as PKCS8 RSA key");
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: input.email,
      scope: input.scopes.join(" "),
      aud: input.audience ?? GOOGLE_TOKEN_URL,
      iat: input.nowSeconds,
      exp: input.nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}
