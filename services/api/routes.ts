import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql, listen } from "../../lib/db";

export const api = new Hono();

// helper: run a query with JWT claims set in the pg session for RLS
async function withAuth(c: any, fn: (tx: typeof sql) => Promise<any>) {
  const user = c.get("user");
  const claims = JSON.stringify({ sub: user.sub, email: user.email, role: user.role });

  return sql.begin(async (tx) => {
    // set JWT claims so auth.user_id() works in RLS policies
    await tx.unsafe(`SELECT set_config('request.jwt.claims', '${claims}', true)`);
    // switch to the restricted role (no BYPASSRLS)
    await tx.unsafe(`SET LOCAL ROLE authenticated`);
    return fn(tx);
  });
}

// ---------- generic CRUD for any table ----------

api.get("/:table", async (c) => {
  const table = c.req.param("table");
  const limit = Number(c.req.query("limit")) || 50;
  const offset = Number(c.req.query("offset")) || 0;

  const rows = await withAuth(c, (tx) =>
    tx`SELECT * FROM ${tx(table)} ORDER BY created_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`
  );
  return c.json(rows);
});

api.get("/:table/:id", async (c) => {
  const { table, id } = c.req.param();
  const rows = await withAuth(c, (tx) =>
    tx`SELECT * FROM ${tx(table)} WHERE id = ${id}`
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

api.post("/:table", async (c) => {
  const table = c.req.param("table");
  const body = await c.req.json();
  const rows = await withAuth(c, (tx) =>
    tx`INSERT INTO ${tx(table)} ${tx(body)} RETURNING *`
  );
  return c.json(rows[0], 201);
});

api.patch("/:table/:id", async (c) => {
  const { table, id } = c.req.param();
  const body = await c.req.json();
  const rows = await withAuth(c, (tx) =>
    tx`UPDATE ${tx(table)} SET ${tx(body)} WHERE id = ${id} RETURNING *`
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

api.delete("/:table/:id", async (c) => {
  const { table, id } = c.req.param();
  const rows = await withAuth(c, (tx) =>
    tx`DELETE FROM ${tx(table)} WHERE id = ${id} RETURNING *`
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

// ---------- log streaming via SSE ----------

api.get("/stream/logs", (c) => {
  return streamSSE(c, async (stream) => {
    await listen("app_log", (payload) => {
      stream.writeSSE({ data: payload, event: "log" });
    });

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" });
    }, 15_000);

    stream.onAbort(() => clearInterval(keepAlive));
  });
});

api.post("/log", async (c) => {
  const body = await c.req.json();
  const payload = JSON.stringify({ ...body, ts: Date.now() });
  await sql`SELECT pg_notify('app_log', ${payload})`;
  return c.json({ sent: true });
});
