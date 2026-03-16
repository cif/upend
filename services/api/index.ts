import { Hono } from "hono";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { cors } from "hono/cors";
import { authRoutes } from "./auth-routes";
import { sql } from "../../lib/db";
import { requireAuth } from "../../lib/middleware";

const app = new Hono();

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
    FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename NOT LIKE '\_%' ESCAPE '\'
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

// data API info — point apps to Neon Data API (PostgREST)
app.get("/data", (c) => c.json({
  message: "Use Neon Data API for data access. Configure it in your Neon console.",
  setup: {
    steps: [
      "1. Enable Data API in Neon console for your project",
      "2. Set JWKS URL to: <your-upend-domain>/.well-known/jwks.json",
      "3. Set JWT audience to: upend",
      "4. Data API exposes all tables in the public schema as REST endpoints",
    ],
    docs: "https://neon.com/docs/data-api/overview",
  },
  schemas: {
    public: "User-facing tables (things, users) — exposed via Data API",
    upend: "Internal tables (sessions, messages) — not exposed",
    auth: "Auth functions (user_id()) — used by RLS policies",
  },
}));

const port = Number(process.env.API_PORT) || 3001;
console.log(`[api] running on :${port}`);

export default { port, fetch: app.fetch };
