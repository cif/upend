import { createMiddleware } from "hono/factory";
import { verifyToken } from "./auth";

type AuthPayload = {
  sub: string;
  email: string;
  role: string;
};

// middleware that verifies JWT from Authorization header or ?token= query param
export const requireAuth = createMiddleware<{
  Variables: { user: AuthPayload };
}>(async (c, next) => {
  const header = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  const method = c.req.method;
  const path = c.req.path;

  if (!token) {
    console.log(`[auth] 401 no token: ${method} ${path}`);
    return c.json({ error: "missing or invalid Authorization" }, 401);
  }

  try {
    const payload = await verifyToken(token);
    const user = {
      sub: payload.sub as string,
      email: payload.email as string,
      role: (payload.app_role as string) || (payload.role as string) || "user",
    };
    console.log(`[auth] ${user.email} → ${method} ${path}`);
    c.set("user", user);
    await next();
  } catch (err: any) {
    console.log(`[auth] 401 invalid token: ${method} ${path} — ${err.message}`);
    return c.json({ error: "invalid token", detail: err.message }, 401);
  }
});

// middleware that requires a specific role
export const requireRole = (...roles: string[]) =>
  createMiddleware(async (c, next) => {
    const user = c.get("user") as AuthPayload | undefined;
    if (!user) return c.json({ error: "not authenticated" }, 401);
    if (!roles.includes(user.role)) {
      console.log(`[auth] 403 forbidden: ${user.email} needs ${roles.join("|")}, has ${user.role}`);
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
