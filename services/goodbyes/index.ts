import { Hono } from "hono";
import { sql } from "../../lib/db";

const app = new Hono();

// GET /services/goodbyes/random — return a random goodbye
app.get("/random", async (c) => {
  const [row] = await sql`SELECT * FROM goodbyes ORDER BY random() LIMIT 1`;
  if (!row) return c.json({ error: "no goodbyes yet" }, 404);
  return c.json(row);
});

// GET /services/goodbyes/ — list all
app.get("/", async (c) => {
  const rows = await sql`SELECT * FROM goodbyes ORDER BY created_at DESC`;
  return c.json(rows);
});

// POST /services/goodbyes/ — create
app.post("/", async (c) => {
  const { message, author } = await c.req.json();
  if (!message) return c.json({ error: "message required" }, 400);
  const [row] = await sql`
    INSERT INTO goodbyes (message, author) VALUES (${message}, ${author || 'anonymous'})
    RETURNING *
  `;
  return c.json(row, 201);
});

export default app;
