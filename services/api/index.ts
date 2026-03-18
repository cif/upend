import { Hono } from "hono";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { cors } from "hono/cors";
import { authRoutes } from "./auth-routes";
import { sql } from "../../lib/db";
import { requireAuth } from "../../lib/middleware";

const app = new Hono();

// audit log — append-only, used across all services
export async function audit(action: string, opts: { actorId?: string; actorEmail?: string; targetType?: string; targetId?: string; detail?: any; ip?: string } = {}) {
  try {
    await sql`INSERT INTO audit.log (actor_id, actor_email, action, target_type, target_id, detail, ip)
      VALUES (${opts.actorId || null}, ${opts.actorEmail || null}, ${action}, ${opts.targetType || null}, ${opts.targetId || null}, ${JSON.stringify(opts.detail || {})}, ${opts.ip || null})`;
  } catch (err) {
    console.error("[audit] failed to write:", err);
  }
}

app.use("*", logger());
app.use("*", timing());
app.use("*", cors());

app.get("/", (c) => c.json({ service: "api", status: "up", ts: Date.now() }));

// auth routes — signup, login, SSO, JWKS
app.route("/", authRoutes);

// schema introspection — used by the dashboard
app.get("/tables", requireAuth, async (c) => {
  const tables = await sql`
    SELECT t.tablename as name,
      (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.tablename AND c.table_schema = 'public') as columns
    FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename != '_migrations'
    ORDER BY t.tablename
  `;
  return c.json(tables);
});

app.get("/tables/:name", requireAuth, async (c) => {
  const name = c.req.param("name");
  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${name}
    ORDER BY ordinal_position
  `;
  return c.json(columns);
});

// ---------- simple CRUD for public schema tables ----------
// works without Neon Data API — direct postgres queries
// sets JWT claims as session vars so RLS policies work

function getUser(c: any) {
  return c.get("user") as { sub: string; email: string; role: string };
}

async function withRLS<T>(user: { sub: string; email: string; role: string }, fn: (sql: any) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL request.jwt.sub = '${user.sub}'`);
    await tx.unsafe(`SET LOCAL request.jwt.role = '${user.role}'`);
    await tx.unsafe(`SET LOCAL request.jwt.email = '${user.email}'`);
    return fn(tx);
  });
}

app.get("/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const select = c.req.query("select") || "*";
  const order = c.req.query("order") || "created_at.desc";
  const limit = c.req.query("limit") || "100";

  // parse order: "created_at.desc" → "created_at DESC"
  const [orderCol, orderDir] = order.split(".");
  const orderSql = `${orderCol} ${orderDir === "asc" ? "ASC" : "DESC"}`;

  // parse filters from query params (PostgREST-style: ?field=eq.value)
  const filters: string[] = [];
  const values: any[] = [];
  for (const [key, val] of Object.entries(c.req.query())) {
    if (["select", "order", "limit"].includes(key)) continue;
    const match = (val as string).match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.+)$/);
    if (match) {
      const [, op, v] = match;
      const ops: Record<string, string> = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE", is: "IS" };
      values.push(v === "null" ? null : v);
      filters.push(`"${key}" ${ops[op]} $${values.length}`);
    }
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const query = `SELECT ${select} FROM "${table}" ${where} ORDER BY ${orderSql} LIMIT ${Number(limit)}`;
  const user = getUser(c);
  const rows = await withRLS(user, (tx) => tx.unsafe(query, values));
  return c.json(rows);
});

app.post("/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const body = await c.req.json();
  const cols = Object.keys(body);
  const vals = Object.values(body);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const query = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders}) RETURNING *`;
  const user = getUser(c);
  const [row] = await withRLS(user, (tx) => tx.unsafe(query, vals));
  return c.json(row, 201);
});

app.patch("/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const body = await c.req.json();

  // parse filters from query params
  const filters: string[] = [];
  const filterVals: any[] = [];
  for (const [key, val] of Object.entries(c.req.query())) {
    const match = (val as string).match(/^(eq)\.(.+)$/);
    if (match) {
      filterVals.push(match[2]);
      filters.push(`"${key}" = $${filterVals.length}`);
    }
  }
  if (!filters.length) return c.json({ error: "filter required for PATCH" }, 400);

  const setCols = Object.keys(body);
  const setVals = Object.values(body);
  const setClause = setCols.map((col, i) => `"${col}" = $${filterVals.length + i + 1}`).join(", ");
  const query = `UPDATE "${table}" SET ${setClause} WHERE ${filters.join(" AND ")} RETURNING *`;
  const user = getUser(c);
  const rows = await withRLS(user, (tx) => tx.unsafe(query, [...filterVals, ...setVals]));
  return c.json(rows);
});

app.delete("/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");

  const filters: string[] = [];
  const vals: any[] = [];
  for (const [key, val] of Object.entries(c.req.query())) {
    const match = (val as string).match(/^(eq)\.(.+)$/);
    if (match) {
      vals.push(match[2]);
      filters.push(`"${key}" = $${vals.length}`);
    }
  }
  if (!filters.length) return c.json({ error: "filter required for DELETE" }, 400);

  const query = `DELETE FROM "${table}" WHERE ${filters.join(" AND ")} RETURNING *`;
  const user = getUser(c);
  const rows = await withRLS(user, (tx) => tx.unsafe(query, vals));
  return c.json(rows);
});

// RLS policies — used by dashboard to display access rules
app.get("/policies", requireAuth, async (c) => {
  const policies = await sql`
    SELECT
      schemaname as schema,
      tablename as table,
      policyname as policy,
      permissive,
      roles,
      cmd as operation,
      qual as using_expr,
      with_check as check_expr
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `;

  // also get which tables have RLS enabled
  const rlsTables = await sql`
    SELECT relname as table, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity = true
  `;

  return c.json({ policies, rlsTables });
});

// ---------- audit log ----------

app.get("/audit", requireAuth, async (c) => {
  const limit = c.req.query("limit") || "100";
  const rows = await sql`
    SELECT * FROM audit.log ORDER BY ts DESC LIMIT ${Number(limit)}
  `;
  return c.json(rows);
});

// ---------- workflows ----------

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const WORKFLOWS_DIR = join(process.env.UPEND_PROJECT || process.cwd(), "workflows");

app.get("/workflows", requireAuth, async (c) => {
  let files: string[];
  try {
    files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
  } catch {
    return c.json([]);
  }

  const workflows = files.map(file => {
    const content = readFileSync(join(WORKFLOWS_DIR, file), "utf-8");
    const cronMatch = content.match(/\/\/\s*@cron\s+(.+)/);
    const descMatch = content.match(/\/\/\s*@description\s+(.+)/);
    return {
      name: file.replace(/\.(ts|js)$/, ""),
      file,
      cron: cronMatch ? cronMatch[1].trim() : null,
      description: descMatch ? descMatch[1].trim() : "",
    };
  });

  return c.json(workflows);
});

app.post("/workflows/:name/run", requireAuth, async (c) => {
  const user = getUser(c);
  if (user.role !== "admin") return c.json({ error: "admin only" }, 403);

  const name = c.req.param("name");
  const file = `${name}.ts`;
  const path = join(WORKFLOWS_DIR, file);

  console.log(`[workflow] ${name} triggered by ${user.email}`);
  const proc = Bun.spawn(["bun", path], {
    cwd: process.env.UPEND_PROJECT || process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(`[workflow] ${name} exit=${exitCode}`);
  await audit("workflow.run", { actorId: user.sub, actorEmail: user.email, targetType: "workflow", targetId: name, detail: { exitCode, stdout: stdout.slice(0, 500) } });
  return c.json({ name, exitCode, stdout, stderr });
});

const port = Number(process.env.API_PORT) || 3001;
console.log(`[api] running on :${port}`);

export default { port, fetch: app.fetch };
