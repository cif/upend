import { Hono } from "hono";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { cors } from "hono/cors";
import { authRoutes } from "./auth-routes";

const app = new Hono();

app.use("*", logger());
app.use("*", timing());
app.use("*", cors());

app.get("/", (c) => c.json({ service: "api", status: "up", ts: Date.now() }));

// auth routes — signup, login, SSO, JWKS
app.route("/", authRoutes);

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
