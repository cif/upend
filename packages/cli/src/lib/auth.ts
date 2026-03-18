import { importPKCS8, importSPKI, exportJWK, SignJWT, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// KEYS_DIR resolves from the user's project, not the package
const PROJECT_ROOT = process.env.UPEND_PROJECT || process.cwd();
const KEYS_DIR = join(PROJECT_ROOT, ".keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "private.pem");
const PUBLIC_KEY_PATH = join(KEYS_DIR, "public.pem");
const ALG = "RS256";
const ISSUER = "upend";

async function ensureKeys() {
  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) return;

  mkdirSync(KEYS_DIR, { recursive: true });
  console.log("[auth] generating RSA key pair...");

  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );

  const privPem = await exportKeyToPem(privateKey, "PRIVATE");
  const pubPem = await exportKeyToPem(publicKey, "PUBLIC");

  writeFileSync(PRIVATE_KEY_PATH, privPem);
  writeFileSync(PUBLIC_KEY_PATH, pubPem);
  console.log("[auth] keys written to .keys/");
}

async function exportKeyToPem(key: CryptoKey, type: "PRIVATE" | "PUBLIC") {
  const format = type === "PRIVATE" ? "pkcs8" : "spki";
  const exported = await crypto.subtle.exportKey(format, key);
  const b64 = Buffer.from(exported).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${type} KEY-----\n${lines}\n-----END ${type} KEY-----\n`;
}

let _privateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null;
let _publicKey: Awaited<ReturnType<typeof importSPKI>> | null = null;

async function getPrivateKey() {
  if (!_privateKey) {
    await ensureKeys();
    _privateKey = await importPKCS8(readFileSync(PRIVATE_KEY_PATH, "utf-8"), ALG);
  }
  return _privateKey;
}

async function getPublicKey() {
  if (!_publicKey) {
    await ensureKeys();
    _publicKey = await importSPKI(readFileSync(PUBLIC_KEY_PATH, "utf-8"), ALG);
  }
  return _publicKey;
}

export async function signToken(userId: string, email: string, appRole: string = "user") {
  const key = await getPrivateKey();
  return new SignJWT({ email, role: "authenticated", app_role: appRole })
    .setProtectedHeader({ alg: ALG, kid: "upend-1" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience("upend")
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(key);
}

export async function verifyToken(token: string) {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: "upend",
  });
  return payload;
}

export async function getJWKS() {
  const key = await getPublicKey();
  const jwk = await exportJWK(key);
  return {
    keys: [
      { ...jwk, kid: "upend-1", alg: ALG, use: "sig" },
    ],
  };
}
