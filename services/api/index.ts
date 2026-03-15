import { Hono } from "hono";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { cors } from "hono/cors";
import { authRoutes } from "./auth-routes";
import { api } from "./routes";
import { requireAuth } from "../../lib/middleware";

const app = new Hono();

app.use("*", logger());
app.use("*", timing());
app.use("*", cors());

app.get("/", (c) => c.json({ service: "api", status: "up", ts: Date.now() }));

// public routes — signup, login, JWKS
app.route("/", authRoutes);

// protected routes — everything else requires a valid JWT
app.use("/data/*", requireAuth);
app.route("/data", api);

const port = Number(process.env.API_PORT) || 3001;
console.log(`[api] running on :${port}`);

export default { port, fetch: app.fetch };
