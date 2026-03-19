import { Hono } from "hono";
import { sql } from "../../lib/db";
import { signToken, getJWKS, verifyToken } from "../../lib/auth";

export const authRoutes = new Hono();

async function audit(action: string, opts: { actorId?: string; actorEmail?: string; targetType?: string; targetId?: string; detail?: any; ip?: string } = {}) {
  try {
    await sql`INSERT INTO audit.log (actor_id, actor_email, action, target_type, target_id, detail, ip)
      VALUES (${opts.actorId || null}, ${opts.actorEmail || null}, ${action}, ${opts.targetType || null}, ${opts.targetId || null}, ${JSON.stringify(opts.detail || {})}, ${opts.ip || null})`;
  } catch (err) {
    console.error("[audit] failed:", err);
  }
}

// JWKS — exported so gateway can mount at root
export async function jwksHandler(c: any) {
  const jwks = await getJWKS();
  return c.json(jwks);
}

// signup (disabled by default — admin creates users, or set SIGNUP_ENABLED=true)
authRoutes.post("/auth/signup", async (c) => {
  // allow if signup is enabled OR if request has a valid admin token
  const authHeader = c.req.header("Authorization");
  let isAdminRequest = false;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = await import("../../lib/auth").then(m => m.verifyToken(authHeader.slice(7)));
      if ((payload as any).app_role === "admin") isAdminRequest = true;
    } catch {}
  }

  if (process.env.SIGNUP_ENABLED !== "true" && !isAdminRequest) {
    return c.json({ error: "signup is disabled — contact the admin" }, 403);
  }

  const { email, password, role } = await c.req.json();
  console.log(`[auth] signup attempt: ${email}`);
  if (!email || !password) return c.json({ error: "email and password required" }, 400);

  const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });

  try {
    const [user] = await sql`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${passwordHash}, ${role || "user"})
      RETURNING id, email, role, created_at
    `;

    const token = await signToken(user.id, user.email, user.role);
    await audit("user.signup", { actorId: user.id, actorEmail: user.email, targetType: "user", targetId: user.id });
    return c.json({ user, token }, 201);
  } catch (err: any) {
    if (err.code === "23505") return c.json({ error: "email already exists" }, 409);
    throw err;
  }
});

// login
authRoutes.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json();
  console.log(`[auth] login attempt: ${email}`);
  if (!email || !password) return c.json({ error: "email and password required" }, 400);

  const [user] = await sql`SELECT * FROM users WHERE email = ${email}`;
  if (!user) return c.json({ error: "invalid credentials" }, 401);

  const valid = await Bun.password.verify(password, user.passwordHash);
  if (!valid) return c.json({ error: "invalid credentials" }, 401);

  const token = await signToken(user.id, user.email, user.role);
  await audit("user.login", { actorId: user.id, actorEmail: user.email, targetType: "user", targetId: user.id });
  return c.json({
    user: { id: user.id, email: user.email, role: user.role },
    token,
  });
});

// impersonate — admin only, mint a token as another user
authRoutes.post("/auth/impersonate", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);

  try {
    const payload = await verifyToken(authHeader.slice(7));
    if ((payload as any).app_role !== "admin") return c.json({ error: "admin only" }, 403);
  } catch {
    return c.json({ error: "invalid token" }, 401);
  }

  const { user_id } = await c.req.json();
  if (!user_id) return c.json({ error: "user_id required" }, 400);

  const [user] = await sql`SELECT id, email, role FROM users WHERE id = ${user_id}`;
  if (!user) return c.json({ error: "user not found" }, 404);

  const token = await signToken(user.id, user.email, user.role);
  const adminPayload = await verifyToken(authHeader!.slice(7));
  await audit("user.impersonate", { actorId: (adminPayload as any).sub, actorEmail: (adminPayload as any).email, targetType: "user", targetId: user.id, detail: { impersonated: user.email } });
  console.log(`[auth] impersonation: admin → ${user.email}`);
  return c.json({ user, token });
});

// ---------- SSO / OAuth ----------
// Generic OAuth flow: works with Google, GitHub, Okta, Azure AD, whatever
// Configure via env: OAUTH_<PROVIDER>_CLIENT_ID, OAUTH_<PROVIDER>_CLIENT_SECRET, etc.

// initiate OAuth login — redirects to provider
authRoutes.get("/auth/sso/:provider", async (c) => {
  const provider = c.req.param("provider");
  const config = getOAuthConfig(provider);
  if (!config) return c.json({ error: `unknown provider: ${provider}` }, 400);

  const state = crypto.randomUUID();
  const redirectUri = `${getBaseUrl(c)}/auth/sso/${provider}/callback`;

  // store state for CSRF validation
  await sql`
    INSERT INTO upend.oauth_states (state, provider, created_at)
    VALUES (${state}, ${provider}, now())
  `;

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
  });

  return c.redirect(`${config.authorizeUrl}?${params}`);
});

// OAuth callback — exchange code for token, find/create user, issue our JWT
authRoutes.get("/auth/sso/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  const config = getOAuthConfig(provider);
  if (!config) return c.json({ error: `unknown provider: ${provider}` }, 400);

  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  // validate state
  const [stateRow] = await sql`
    DELETE FROM upend.oauth_states WHERE state = ${state} AND provider = ${provider}
    AND created_at > now() - interval '10 minutes'
    RETURNING *
  `;
  if (!stateRow) return c.json({ error: "invalid or expired state" }, 400);

  // exchange code for tokens
  const redirectUri = `${getBaseUrl(c)}/auth/sso/${provider}/callback`;
  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json() as any;
  if (!tokens.access_token) return c.json({ error: "token exchange failed", detail: tokens }, 400);

  // get user info from provider
  const userInfoRes = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = await userInfoRes.json() as any;

  const email = userInfo.email || userInfo.mail;
  if (!email) return c.json({ error: "could not get email from provider" }, 400);

  // find or create user
  let [user] = await sql`SELECT * FROM users WHERE email = ${email}`;
  if (!user) {
    [user] = await sql`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${"sso:" + provider}, 'user')
      RETURNING *
    `;
  }

  // issue OUR JWT — same as email/password login
  const token = await signToken(user.id, email, user.role);

  // redirect with token (frontend picks it up)
  const frontendUrl = process.env.FRONTEND_URL || "/";
  return c.redirect(`${frontendUrl}?token=${token}`);
});

// ---------- OAuth provider configs ----------

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
};

function getOAuthConfig(provider: string): OAuthConfig | null {
  const prefix = `OAUTH_${provider.toUpperCase()}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) return null;

  const providers: Record<string, Omit<OAuthConfig, "clientId" | "clientSecret">> = {
    google: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      scope: "email profile",
    },
    github: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userInfoUrl: "https://api.github.com/user",
      scope: "user:email",
    },
    microsoft: {
      authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      userInfoUrl: "https://graph.microsoft.com/v1.0/me",
      scope: "openid email profile",
    },
  };

  const p = providers[provider];
  if (!p) {
    // generic OIDC — provide all URLs via env
    const authorizeUrl = process.env[`${prefix}_AUTHORIZE_URL`];
    const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
    const userInfoUrl = process.env[`${prefix}_USERINFO_URL`];
    const scope = process.env[`${prefix}_SCOPE`] || "openid email profile";
    if (!authorizeUrl || !tokenUrl || !userInfoUrl) return null;
    return { clientId, clientSecret, authorizeUrl, tokenUrl, userInfoUrl, scope };
  }

  return { clientId, clientSecret, ...p };
}

function getBaseUrl(c: any): string {
  return process.env.BASE_URL || `${c.req.url.split("/auth")[0]}`;
}
