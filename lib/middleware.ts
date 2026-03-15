import { createMiddleware } from "hono/factory";
import { verifyToken } from "./auth";

type AuthPayload = {
  sub: string;
  email: string;
  role: string;
};

// middleware that verifies JWT from Authorization header
export const requireAuth = createMiddleware<{
  Variables: { user: AuthPayload };
}>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "missing or invalid Authorization header" }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = await verifyToken(token);
    c.set("user", {
      sub: payload.sub as string,
      email: payload.email as string,
      role: (payload.role as string) || "user",
    });
    await next();
  } catch (err: any) {
    return c.json({ error: "invalid token", detail: err.message }, 401);
  }
});

// middleware that requires a specific role
export const requireRole = (...roles: string[]) =>
  createMiddleware(async (c, next) => {
    const user = c.get("user") as AuthPayload | undefined;
    if (!user) return c.json({ error: "not authenticated" }, 401);
    if (!roles.includes(user.role)) return c.json({ error: "forbidden" }, 403);
    await next();
  });
