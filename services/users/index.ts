import { Hono } from "hono";
import { sql } from "../../lib/db";
import { requireAuth, requireRole } from "../../lib/middleware";

const app = new Hono();

// reset password — admin only
app.post("/reset-password", requireAuth, requireRole("admin"), async (c) => {
  const { user_id, new_password } = await c.req.json();
  if (!user_id || !new_password) return c.json({ error: "user_id and new_password required" }, 400);

  const [user] = await sql`SELECT id, email FROM users WHERE id = ${user_id}`;
  if (!user) return c.json({ error: "user not found" }, 404);

  const passwordHash = await Bun.password.hash(new_password, { algorithm: "argon2id" });
  await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${user_id}`;

  console.log(`[users] password reset for ${user.email}`);
  return c.json({ ok: true });
});

export default app;
