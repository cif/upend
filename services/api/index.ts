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

// OpenAPI spec
app.get("/openapi.json", (c) => c.json({
  openapi: "3.1.0",
  info: { title: "upend API", version: "1.0.0", description: "Anti-SaaS API. Generic CRUD on any table with JWT auth and RLS." },
  servers: [{ url: "/api" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } } },
    },
  },
  paths: {
    "/auth/signup": {
      post: {
        tags: ["auth"], summary: "Create account",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" }, role: { type: "string", default: "user" } } } } } },
        responses: { "201": { description: "Account created with JWT token" }, "409": { description: "Email already exists" } },
      },
    },
    "/auth/login": {
      post: {
        tags: ["auth"], summary: "Login",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } } } } },
        responses: { "200": { description: "JWT token" }, "401": { description: "Invalid credentials" } },
      },
    },
    "/auth/sso/{provider}": {
      get: {
        tags: ["auth"], summary: "Initiate OAuth/SSO login",
        parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string", enum: ["google", "github", "microsoft"] } }],
        responses: { "302": { description: "Redirect to OAuth provider" } },
      },
    },
    "/data/{table}": {
      get: {
        tags: ["data"], summary: "List rows", security: [{ bearer: [] }],
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "Array of rows" } },
      },
      post: {
        tags: ["data"], summary: "Create row", security: [{ bearer: [] }],
        parameters: [{ name: "table", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "201": { description: "Created row" } },
      },
    },
    "/data/{table}/{id}": {
      get: {
        tags: ["data"], summary: "Get row", security: [{ bearer: [] }],
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Row" }, "404": { description: "Not found" } },
      },
      patch: {
        tags: ["data"], summary: "Update row", security: [{ bearer: [] }],
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Updated row" }, "404": { description: "Not found" } },
      },
      delete: {
        tags: ["data"], summary: "Delete row", security: [{ bearer: [] }],
        parameters: [
          { name: "table", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Deleted row" }, "404": { description: "Not found" } },
      },
    },
    "/stream/logs": {
      get: {
        tags: ["streaming"], summary: "SSE log stream", security: [{ bearer: [] }],
        responses: { "200": { description: "Server-sent events stream" } },
      },
    },
    "/.well-known/jwks.json": {
      get: {
        tags: ["auth"], summary: "JWKS public keys",
        responses: { "200": { description: "JSON Web Key Set" } },
      },
    },
  },
}));

// public routes — signup, login, JWKS
app.route("/", authRoutes);

// protected routes — everything else requires a valid JWT
app.use("/data/*", requireAuth);
app.route("/data", api);

const port = Number(process.env.API_PORT) || 3001;
console.log(`[api] running on :${port}`);

export default { port, fetch: app.fetch };
