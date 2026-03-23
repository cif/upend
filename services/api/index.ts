import { Hono } from "hono";
import { logger } from "hono/logger";
import { timing } from "hono/timing";
import { cors } from "hono/cors";
import { authRoutes, jwksHandler } from "./auth-routes";
import { sql } from "../../lib/db";
import { requireAuth } from "../../lib/middleware";
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const app = new Hono();

const PROJECT_ROOT = process.env.UPEND_PROJECT || process.cwd();
const SESSIONS_DIR = join(PROJECT_ROOT, "sessions");

// session-aware path resolver
function resolveRoot(c: any): string {
  const session = c.req.header("X-Upend-Session")
    || c.req.query("_session")
    || c.req.header("Cookie")?.match(/upend_session=([^;]+)/)?.[1];
  if (session && session !== "main") {
    const sessionPath = join(SESSIONS_DIR, session);
    if (existsSync(sessionPath)) return sessionPath;
  }
  return PROJECT_ROOT;
}

// audit log helper
export async function audit(action: string, opts: { actorId?: string; actorEmail?: string; targetType?: string; targetId?: string; detail?: any; ip?: string } = {}) {
  try {
    await sql`INSERT INTO audit.log (actor_id, actor_email, action, target_type, target_id, detail, ip)
      VALUES (${opts.actorId || null}, ${opts.actorEmail || null}, ${action}, ${opts.targetType || null}, ${opts.targetId || null}, ${JSON.stringify(opts.detail || {})}, ${opts.ip || null})`;
  } catch (err) {
    console.error("[audit] failed to write:", err);
  }
}

function getUser(c: any) {
  return c.get("user") as { sub: string; email: string; role: string; app_role?: string };
}

async function withRLS<T>(user: { sub: string; email: string; role: string; app_role?: string }, fn: (sql: any) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    // drop to 'authenticated' role so RLS is enforced (neondb_owner has BYPASSRLS)
    await tx.unsafe(`SET LOCAL role = 'authenticated'`);
    await tx.unsafe(`SET LOCAL request.jwt.sub = '${user.sub}'`);
    await tx.unsafe(`SET LOCAL request.jwt.role = '${user.role}'`);
    await tx.unsafe(`SET LOCAL request.jwt.email = '${user.email}'`);
    await tx.unsafe(`SET LOCAL request.jwt.app_role = '${user.app_role || user.role}'`);
    return fn(tx);
  });
}

app.use("*", logger());
app.use("*", timing());
app.use("*", cors());

// ---------- /api/* routes ----------

app.get("/api/health", (c) => c.json({ service: "api", status: "up", ts: Date.now() }));

// system metrics (memory, swap, load, disk, top processes)
app.get("/api/system", requireAuth, async (c) => {
  const { execSync } = await import("child_process");
  const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

  // parse /proc/meminfo
  const meminfo = run("cat /proc/meminfo");
  const mem = (key: string) => {
    const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? Number(m[1]) * 1024 : 0; // convert KB to bytes
  };
  const memTotal = mem("MemTotal");
  const memAvailable = mem("MemAvailable");
  const swapTotal = mem("SwapTotal");
  const swapFree = mem("SwapFree");

  // load average
  const loadavg = run("cat /proc/loadavg").split(" ");

  // disk
  const dfLine = run("df -B1 / | tail -1").split(/\s+/);

  // uptime
  const uptimeSecs = parseFloat(run("cat /proc/uptime").split(" ")[0]);

  // top processes by memory
  const psOut = run("ps aux --sort=-%mem | head -8").split("\n").slice(1);
  const topProcs = psOut.map(line => {
    const cols = line.split(/\s+/);
    return { user: cols[0], pid: cols[1], cpu: parseFloat(cols[2]), mem: parseFloat(cols[3]), rss: Number(cols[5]) * 1024, command: cols.slice(10).join(" ").slice(0, 80) };
  });

  // check for recent OOM kills
  let oomKills: string[] = [];
  try { oomKills = run("dmesg --time-format iso 2>/dev/null | grep -i 'oom-kill\\|out of memory' | tail -5").split("\n").filter(Boolean); } catch {}

  return c.json({
    memory: { total: memTotal, available: memAvailable, used: memTotal - memAvailable, usedPct: Math.round((1 - memAvailable / memTotal) * 100) },
    swap: { total: swapTotal, free: swapFree, used: swapTotal - swapFree, usedPct: swapTotal ? Math.round((1 - swapFree / swapTotal) * 100) : 0 },
    load: { avg1: parseFloat(loadavg[0]), avg5: parseFloat(loadavg[1]), avg15: parseFloat(loadavg[2]) },
    disk: { total: Number(dfLine[1]), used: Number(dfLine[2]), available: Number(dfLine[3]), usedPct: parseInt(dfLine[4]) },
    uptime: uptimeSecs,
    topProcesses: topProcs,
    oomKills,
    ts: Date.now(),
  });
});

// JWKS at root (Neon fetches this)
app.get("/.well-known/jwks.json", jwksHandler);

// auth
app.route("/api", authRoutes);

// apps list
app.get("/api/apps", requireAuth, async (c) => {
  const root = resolveRoot(c);
  const seen = new Set<string>();
  const apps: any[] = [];
  for (const base of [root, PROJECT_ROOT]) {
    const appsDir = join(base, "apps");
    try {
      for (const name of readdirSync(appsDir)) {
        if (seen.has(name)) continue;
        const dir = join(appsDir, name);
        if (statSync(dir).isDirectory()) {
          seen.add(name);
          apps.push({ name, url: `/apps/${name}/`, source: base === root && root !== PROJECT_ROOT ? "session" : "main" });
        }
      }
    } catch {}
  }
  return c.json(apps);
});

// schema introspection
app.get("/api/tables", requireAuth, async (c) => {
  const tables = await sql`
    SELECT t.tablename as name,
      (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.tablename AND c.table_schema = 'public') as columns
    FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename != '_migrations'
    ORDER BY t.tablename
  `;
  return c.json(tables);
});

app.get("/api/tables/:name", requireAuth, async (c) => {
  const name = c.req.param("name");
  const columns = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${name}
    ORDER BY ordinal_position
  `;
  return c.json(columns);
});

// data CRUD (RLS enforced)
app.get("/api/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const select = c.req.query("select") || "*";
  const order = c.req.query("order") || "created_at.desc";
  const limit = c.req.query("limit") || "100";
  const [orderCol, orderDir] = order.split(".");
  const orderSql = `${orderCol} ${orderDir === "asc" ? "ASC" : "DESC"}`;

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

app.post("/api/data/:table", requireAuth, async (c) => {
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

app.patch("/api/data/:table", requireAuth, async (c) => {
  const table = c.req.param("table");
  const body = await c.req.json();
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

app.delete("/api/data/:table", requireAuth, async (c) => {
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

// RLS policies
app.get("/api/policies", requireAuth, async (c) => {
  const policies = await sql`
    SELECT schemaname as schema, tablename as table, policyname as policy,
      permissive, roles, cmd as operation, qual as using_expr, with_check as check_expr
    FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname
  `;
  const rlsTables = await sql`
    SELECT relname as table, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity = true
  `;
  return c.json({ policies, rlsTables });
});

// audit log
app.get("/api/audit", requireAuth, async (c) => {
  const limit = c.req.query("limit") || "100";
  const rows = await sql`SELECT * FROM audit.log ORDER BY ts DESC LIMIT ${Number(limit)}`;
  return c.json(rows);
});

// tasks
app.get("/api/tasks", requireAuth, async (c) => {
  const root = resolveRoot(c);
  const seen = new Set<string>();
  const tasks: any[] = [];
  for (const base of [root, PROJECT_ROOT]) {
    const tasksDir = join(base, "tasks");
    let files: string[];
    try { files = readdirSync(tasksDir).filter(f => f.endsWith(".ts") || f.endsWith(".js")); } catch { continue; }
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const content = readFileSync(join(tasksDir, file), "utf-8");
      const cronMatch = content.match(/\/\/\s*@cron\s+(.+)/);
      const descMatch = content.match(/\/\/\s*@description\s+(.+)/);
      const disabled = /\/\/\s*@disabled/.test(content);
      tasks.push({
        name: file.replace(/\.(ts|js)$/, ""),
        file,
        cron: cronMatch ? cronMatch[1].trim() : null,
        description: descMatch ? descMatch[1].trim() : "",
        disabled,
        source: base === root && root !== PROJECT_ROOT ? "session" : "main",
      });
    }
  }
  return c.json(tasks);
});

// toggle task enabled/disabled
app.patch("/api/tasks/:name/toggle", requireAuth, async (c) => {
  const name = c.req.param("name");
  const root = resolveRoot(c);
  let filePath: string | null = null;
  for (const base of [root, PROJECT_ROOT]) {
    for (const ext of [".ts", ".js"]) {
      const candidate = join(base, "tasks", name + ext);
      if (existsSync(candidate)) { filePath = candidate; break; }
    }
    if (filePath) break;
  }
  if (!filePath) return c.json({ error: "task not found" }, 404);

  let content = readFileSync(filePath, "utf-8");
  const isDisabled = /\/\/\s*@disabled/.test(content);
  if (isDisabled) {
    content = content.replace(/\/\/\s*@disabled\n?/, "");
  } else {
    // insert @disabled after the last annotation comment (after @cron or @description)
    const lastAnnotation = [...content.matchAll(/\/\/\s*@(?:cron|description)\s+.+\n/g)];
    if (lastAnnotation.length > 0) {
      const last = lastAnnotation[lastAnnotation.length - 1];
      const pos = last.index! + last[0].length;
      content = content.slice(0, pos) + "// @disabled\n" + content.slice(pos);
    } else {
      content = "// @disabled\n" + content;
    }
  }
  writeFileSync(filePath, content);
  return c.json({ name, disabled: !isDisabled });
});

// services introspection
app.get("/api/services", requireAuth, async (c) => {
  const root = resolveRoot(c);
  const seen = new Set<string>();
  const services: any[] = [];
  const skip = new Set(["api", "claude", "dashboard"]); // framework services
  for (const base of [root, PROJECT_ROOT]) {
    const servicesDir = join(base, "services");
    let dirs: string[];
    try { dirs = readdirSync(servicesDir).filter(d => !skip.has(d) && existsSync(join(servicesDir, d, "index.ts"))); } catch { continue; }
    for (const name of dirs) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entryPath = join(servicesDir, name, "index.ts");
      const content = readFileSync(entryPath, "utf-8");
      // extract route definitions: app.get("/path", ...), app.post("/path", ...), etc.
      const routes: { method: string; path: string }[] = [];
      const routeRegex = /app\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
      let match;
      while ((match = routeRegex.exec(content)) !== null) {
        routes.push({ method: match[1].toUpperCase(), path: `/services/${name}${match[2]}` });
      }
      services.push({
        name,
        routes,
        source: base === root && root !== PROJECT_ROOT ? "session" : "main",
      });
    }
  }
  return c.json(services);
});

app.post("/api/tasks/:name/run", requireAuth, async (c) => {
  const user = getUser(c);
  if (user.app_role !== "admin") return c.json({ error: "admin only" }, 403);
  const root = resolveRoot(c);
  const name = c.req.param("name");
  const filePath = join(root, "tasks", `${name}.ts`);
  if (!existsSync(filePath)) return c.json({ error: `task '${name}' not found` }, 404);

  console.log(`[task] ${name} triggered by ${user.email} (root: ${root})`);
  const proc = Bun.spawn(["bun", filePath], { cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  console.log(`[task] ${name} exit=${exitCode}`);
  await audit("task.run", { actorId: user.sub, actorEmail: user.email, targetType: "task", targetId: name, detail: { exitCode, stdout: stdout.slice(0, 500) } });
  return c.json({ name, exitCode, stdout, stderr });
});

// ---------- /apps/* (file serving, with auth) ----------

app.get("/apps/*", async (c) => {
  // check if this app is public (has a 'public' marker file)
  const appName = c.req.path.replace("/apps/", "").split("/")[0];
  const root = resolveRoot(c);
  const isPublicApp = [join(root, "apps", appName, "public"), join(PROJECT_ROOT, "apps", appName, "public")]
    .some(p => existsSync(p));

  if (!isPublicApp) {
    // check auth — redirect to login instead of JSON 401
    const header = c.req.header("Authorization");
    const cookieHeader = c.req.header("Cookie") || "";
    const cookieToken = cookieHeader.match(/upend_token=([^;]+)/)?.[1];
    const token = header?.startsWith("Bearer ") ? header.slice(7) : cookieToken;

    if (!token) {
      // If loaded in an iframe (Sec-Fetch-Dest: iframe), return 401 page instead of
      // redirecting to dashboard (which causes infinite iframe recursion)
      if (c.req.header("Sec-Fetch-Dest") === "iframe") {
        return c.html(`<html><body style="background:#0a0a0a;color:#737373;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>not authenticated — <a href="/" target="_top" style="color:#f97316">log in</a></p></body></html>`, 401);
      }
      return c.redirect(`/?next=${encodeURIComponent(c.req.path)}`);
    }

    try {
      const { verifyToken } = await import("../../lib/auth");
      await verifyToken(token);
    } catch {
      if (c.req.header("Sec-Fetch-Dest") === "iframe") {
        return c.html(`<html><body style="background:#0a0a0a;color:#737373;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>session expired — <a href="/" target="_top" style="color:#f97316">log in</a></p></body></html>`, 401);
      }
      return c.redirect(`/?next=${encodeURIComponent(c.req.path)}`);
    }
  }

  const path = c.req.path.replace("/apps/", "");
  for (const base of [join(root, "apps"), join(PROJECT_ROOT, "apps")]) {
    const filePath = join(base, path);
    for (const candidate of [filePath, join(filePath, "index.html")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const file = Bun.file(candidate);
        return new Response(file, {
          headers: { "Content-Type": file.type || "text/html", "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
      }
    }
  }
  return c.json({ error: "not found" }, 404);
});

// ---------- /services/* (dispatcher) ----------

const serviceCache = new Map<string, { mod: any; mtime: number }>();

app.all("/services/:name/*", async (c) => {
  const root = resolveRoot(c);
  const serviceName = c.req.param("name");
  const isPublicService = [join(root, "services", serviceName, "public"), join(PROJECT_ROOT, "services", serviceName, "public")]
    .some(p => existsSync(p));

  if (!isPublicService) {
    const authResult = await requireAuth(c, async () => {});
    if (authResult) return authResult;
  }

  for (const base of [root, PROJECT_ROOT]) {
    const entryPath = join(base, "services", serviceName, "index.ts");
    if (existsSync(entryPath)) return dispatchService(c, entryPath, serviceName);
  }
  return c.json({ error: `service '${serviceName}' not found` }, 404);
});

async function dispatchService(c: any, entryPath: string, serviceName: string) {
  try {
    const stat = statSync(entryPath);
    const cached = serviceCache.get(entryPath);
    if (cached && cached.mtime === stat.mtimeMs) {
      const subPath = c.req.path.replace(`/services/${serviceName}`, "") || "/";
      const url = new URL(c.req.url);
      url.pathname = subPath;
      return cached.mod.default.fetch(new Request(url.toString(), c.req.raw));
    }
    const mod = await import(`${entryPath}?t=${stat.mtimeMs}`);
    serviceCache.set(entryPath, { mod, mtime: stat.mtimeMs });
    if (mod.default?.fetch) {
      const subPath = c.req.path.replace(`/services/${serviceName}`, "") || "/";
      const url = new URL(c.req.url);
      url.pathname = subPath;
      return mod.default.fetch(new Request(url.toString(), c.req.raw));
    } else if (typeof mod.default === "function") {
      return mod.default(c);
    }
    return c.json({ error: "service has no default export" }, 500);
  } catch (err: any) {
    console.error(`[service:dispatch] ${entryPath}: ${err.message}`);
    return c.json({ error: err.message }, 500);
  }
}

// ---------- dashboard (catch-all, no auth) ----------

const DASHBOARD_DIR = process.env.UPEND_DASHBOARD_DIR
  || join(new URL("../dashboard/public", import.meta.url).pathname);

app.get("/*", async (c) => {
  const path = c.req.path;
  const filePath = join(DASHBOARD_DIR, path);
  for (const candidate of [filePath, join(filePath, "index.html")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return new Response(Bun.file(candidate), {
        headers: { "Content-Type": Bun.file(candidate).type || "text/html" },
      });
    }
  }
  // SPA fallback
  const indexPath = join(DASHBOARD_DIR, "index.html");
  if (existsSync(indexPath)) {
    return new Response(Bun.file(indexPath), { headers: { "Content-Type": "text/html" } });
  }
  return c.json({ error: "not found" }, 404);
});

// ---------- cron scheduler ----------

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.push(i);
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      for (let i = a; i <= b; i += step) values.push(i);
    } else {
      values.push(Number(range));
    }
  }
  return values;
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const checks: [string, number, number, number][] = [
    [minF, date.getUTCMinutes(), 0, 59],
    [hourF, date.getUTCHours(), 0, 23],
    [domF, date.getUTCDate(), 1, 31],
    [monF, date.getUTCMonth() + 1, 1, 12],
    [dowF, date.getUTCDay(), 0, 7],
  ];
  return checks.every(([field, val, min, max]) =>
    parseCronField(field, min, max).includes(val)
  );
}

function loadCronTasks(): { name: string; cron: string; filePath: string }[] {
  const tasksDir = join(PROJECT_ROOT, "tasks");
  try {
    return readdirSync(tasksDir)
      .filter(f => f.endsWith(".ts") || f.endsWith(".js"))
      .map(file => {
        const content = readFileSync(join(tasksDir, file), "utf-8");
        const cronMatch = content.match(/\/\/\s*@cron\s+(.+)/);
        const disabled = /\/\/\s*@disabled/.test(content);
        return cronMatch && !disabled
          ? { name: file.replace(/\.(ts|js)$/, ""), cron: cronMatch[1].trim(), filePath: join(tasksDir, file) }
          : null;
      })
      .filter(Boolean) as { name: string; cron: string; filePath: string }[];
  } catch {
    return [];
  }
}

const cronLastRun = new Map<string, string>();

function startCronScheduler() {
  let tasks = loadCronTasks();
  console.log(`[cron] loaded ${tasks.length} scheduled task(s): ${tasks.map(t => t.name).join(", ") || "none"}`);

  // reload task list every 5 minutes to pick up new/changed tasks
  setInterval(() => {
    tasks = loadCronTasks();
  }, 5 * 60_000);

  setInterval(() => {
    const now = new Date();
    // key by minute so we only run once per matching minute
    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;

    for (const task of tasks) {
      if (!cronMatches(task.cron, now)) continue;
      const runKey = `${task.name}:${minuteKey}`;
      if (cronLastRun.has(runKey)) continue;
      cronLastRun.set(runKey, new Date().toISOString());

      console.log(`[cron] running ${task.name} (schedule: ${task.cron})`);
      const proc = Bun.spawn(["bun", task.filePath], { cwd: PROJECT_ROOT, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
      proc.exited.then(async (exitCode) => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        console.log(`[cron] ${task.name} exit=${exitCode}${stderr ? ` stderr=${stderr.slice(0, 200)}` : ""}`);
        await audit("task.cron", { targetType: "task", targetId: task.name, detail: { exitCode, stdout: stdout.slice(0, 500), cron: task.cron } });
      });

      // keep map from growing forever — prune old entries
      if (cronLastRun.size > 1000) {
        const keys = [...cronLastRun.keys()];
        for (let i = 0; i < keys.length - 100; i++) cronLastRun.delete(keys[i]);
      }
    }
  }, 30_000);
}

startCronScheduler();

const port = Number(process.env.API_PORT) || 3001;
console.log(`[api] running on :${port}`);

export default { port, fetch: app.fetch };

// This should not be appended — using sed instead
