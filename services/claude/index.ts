import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { sql } from "../../lib/db";
import { requireAuth } from "../../lib/middleware";
import { snapshot, listSnapshots, restoreSnapshot } from "./snapshots";

const app = new Hono();
app.use("*", logger());
app.use("*", cors());

// serve the chat UI (public — auth happens client-side)
app.use("/ui/*", serveStatic({ root: "./services/claude/public", rewriteRequestPath: (p) => p.replace("/ui", "") }));
app.get("/", (c) => c.redirect("/ui/"));

// everything else requires auth
app.use("*", requireAuth);

const PROJECT_ROOT = process.env.UPEND_ROOT || process.cwd();

// ---------- sessions (conversations) ----------

// start a new session — snapshots everything, sends first message
app.post("/sessions", async (c) => {
  const { prompt, force } = await c.req.json();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const user = c.get("user") as { sub: string; email: string };

  // check for active sessions
  const activeSessions = await sql`
    SELECT es.*,
      (SELECT sm.content FROM session_messages sm WHERE sm.session_id = es.id ORDER BY sm.created_at DESC LIMIT 1) as last_message
    FROM editing_sessions es
    WHERE es.status = 'active'
    ORDER BY es.created_at DESC
  `;

  if (activeSessions.length > 0 && !force) {
    return c.json({
      error: "active_sessions",
      message: "There are active editing sessions. Creating a new session shares the same codebase — if anyone rolls back, ALL sessions are affected.",
      activeSessions: activeSessions.map((s: any) => ({
        id: s.id,
        prompt: s.prompt,
        snapshotName: s.snapshotName,
        createdAt: s.createdAt,
        lastMessage: s.lastMessage,
      })),
      options: {
        force: 'Send { force: true } to create a new session anyway (takes a new snapshot)',
        join: `Send a message to an existing session: POST /sessions/${activeSessions[0].id}/messages`,
      },
    }, 409);
  }

  // snapshot files + db before anything happens
  const snap = await snapshot(PROJECT_ROOT);

  // create a claude session id for --resume
  const claudeSessionId = crypto.randomUUID();

  const [session] = await sql`
    INSERT INTO editing_sessions (prompt, status, claude_session_id, snapshot_name, context)
    VALUES (${prompt}, 'active', ${claudeSessionId}, ${snap}, ${JSON.stringify({ root: PROJECT_ROOT })})
    RETURNING *
  `;

  // record the first message
  const [msg] = await sql`
    INSERT INTO session_messages (session_id, role, content, status)
    VALUES (${session.id}, 'user', ${prompt}, 'pending')
    RETURNING *
  `;

  // fire off claude
  runMessage(session.id, msg.id, prompt, claudeSessionId, false);

  return c.json({ session, message: msg, snapshot: snap }, 201);
});

// send a follow-up message to an existing session
app.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const { prompt } = await c.req.json();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const [session] = await sql`SELECT * FROM editing_sessions WHERE id = ${sessionId}`;
  if (!session) return c.json({ error: "session not found" }, 404);
  if (session.status !== "active") return c.json({ error: `session is ${session.status}` }, 400);

  // check no message is currently running
  const [running] = await sql`
    SELECT id FROM session_messages
    WHERE session_id = ${sessionId} AND status = 'running'
  `;
  if (running) return c.json({ error: "a message is already running, wait or kill it" }, 409);

  const [msg] = await sql`
    INSERT INTO session_messages (session_id, role, content, status)
    VALUES (${sessionId}, 'user', ${prompt}, 'pending')
    RETURNING *
  `;

  // --resume continues the same claude conversation
  runMessage(Number(sessionId), msg.id, prompt, session.claudeSessionId, true);

  return c.json(msg, 201);
});

// get session with all messages
app.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const [session] = await sql`SELECT * FROM editing_sessions WHERE id = ${id}`;
  if (!session) return c.json({ error: "not found" }, 404);

  const messages = await sql`
    SELECT * FROM session_messages WHERE session_id = ${id} ORDER BY created_at
  `;
  return c.json({ ...session, messages });
});

app.get("/sessions", async (c) => {
  const rows = await sql`
    SELECT * FROM editing_sessions ORDER BY created_at DESC LIMIT 50
  `;
  return c.json(rows);
});

// stream session output in realtime (works for any message in the session)
app.get("/sessions/:id/stream", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const channel = `session_${id}`;
    await sql.listen(channel, (payload) => {
      stream.writeSSE({ data: payload, event: "update" });
    });

    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" });
    }, 15_000);

    stream.onAbort(() => clearInterval(keepAlive));
  });
});

// end a session
app.post("/sessions/:id/end", async (c) => {
  const id = c.req.param("id");
  await sql`UPDATE editing_sessions SET status = 'ended' WHERE id = ${id}`;
  activeProcesses.delete(Number(id));
  return c.json({ ended: true });
});

// kill the currently running message
app.post("/sessions/:id/kill", async (c) => {
  const id = Number(c.req.param("id"));
  const proc = activeProcesses.get(id);
  if (!proc) return c.json({ error: "nothing running" }, 404);
  proc.kill();
  activeProcesses.delete(id);
  await sql`
    UPDATE session_messages SET status = 'killed'
    WHERE session_id = ${id} AND status = 'running'
  `;
  return c.json({ killed: true });
});

// ---------- apps — hot deployed frontends ----------

import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const APPS_DIR = join(PROJECT_ROOT, "apps");

// list all apps
app.get("/apps", async (c) => {
  mkdirSync(APPS_DIR, { recursive: true });
  const apps = readdirSync(APPS_DIR)
    .filter((f) => statSync(join(APPS_DIR, f)).isDirectory())
    .map((name) => ({
      name,
      url: `/apps/${name}/`,
      created: statSync(join(APPS_DIR, name)).birthtime,
    }));
  return c.json(apps);
});

// create an app from raw files — instantly live, no restart
app.post("/apps", async (c) => {
  const { name, files } = await c.req.json();
  if (!name) return c.json({ error: "name is required" }, 400);

  const appDir = join(APPS_DIR, name);

  if (files && typeof files === "object") {
    // write files directly: { "index.html": "<html>...", "app.js": "..." }
    mkdirSync(appDir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(appDir, filename);
      // support nested paths
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, content as string);
    }

    return c.json({
      app: name,
      url: `/apps/${name}/`,
      files: Object.keys(files),
      live: true,
    }, 201);
  }

  return c.json({ error: "provide files: { 'index.html': '...' }" }, 400);
});

// create an app via Claude — give it a prompt, it builds the app
app.post("/apps/generate", async (c) => {
  const { name, prompt } = await c.req.json();
  if (!name || !prompt) return c.json({ error: "name and prompt required" }, 400);

  const appDir = join(APPS_DIR, name);
  mkdirSync(appDir, { recursive: true });

  // build the meta-prompt — tell Claude to create a self-contained app
  const metaPrompt = `Create a self-contained web app in the directory ${appDir}.

The app will be served as static files at /apps/${name}/ — it needs at minimum an index.html.
It can talk to the API at /api/ (same origin). Auth tokens are stored in localStorage as 'upend_token'.
Use the Bearer token in Authorization headers for API calls.

The API has these endpoints:
- POST /api/auth/signup — { email, password } → { user, token }
- POST /api/auth/login — { email, password } → { user, token }
- GET /api/data/:table — list rows (requires auth)
- POST /api/data/:table — create row (requires auth)
- PATCH /api/data/:table/:id — update row (requires auth)
- DELETE /api/data/:table/:id — delete row (requires auth)

Keep it simple. Single page app. No build step. No framework unless needed.
Use modern CSS and vanilla JS unless the prompt specifically asks for a framework.

User's request: ${prompt}`;

  // fire claude — no snapshot needed, this is just writing new files
  const proc = Bun.spawn(
    ["claude", "-p", metaPrompt, "--output-format", "stream-json", "--verbose"],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "upend", DISABLE_PROMPT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  // stream progress via pg notify
  const channel = `app_${name}`;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n").filter(Boolean)) {
        const payload = JSON.stringify({ type: "chunk", raw: line, ts: Date.now() });
        await sql`SELECT pg_notify(${channel}, ${payload})`;
      }
    }
    const exitCode = await proc.exited;
    const status = exitCode === 0 ? "complete" : "error";
    const payload = JSON.stringify({ type: "status", status, ts: Date.now() });
    await sql`SELECT pg_notify(${channel}, ${payload})`;
  })();

  return c.json({
    app: name,
    url: `/apps/${name}/`,
    status: "generating",
    stream: `/apps/${name}/stream`,
  }, 202);
});

// stream app generation progress
app.get("/apps/:name/stream", (c) => {
  const name = c.req.param("name");
  return streamSSE(c, async (stream) => {
    const channel = `app_${name}`;
    await sql.listen(channel, (payload) => {
      stream.writeSSE({ data: payload, event: "update" });
    });
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" });
    }, 15_000);
    stream.onAbort(() => clearInterval(keepAlive));
  });
});

// ---------- snapshots / rollback ----------

app.get("/snapshots", async (c) => {
  const snaps = await listSnapshots(PROJECT_ROOT);
  return c.json(snaps);
});

app.post("/rollback", async (c) => {
  const { snapshot: snapName, restoreDb } = await c.req.json();
  if (!snapName) return c.json({ error: "snapshot name required" }, 400);

  // safety snapshot before rollback
  const safety = await snapshot(PROJECT_ROOT);

  await restoreSnapshot(PROJECT_ROOT, snapName, { restoreDb: restoreDb !== false });

  restartServices();

  return c.json({ rolledBack: snapName, safetySnapshot: safety });
});

// ---------- claude process management ----------

const activeProcesses = new Map<number, ReturnType<typeof Bun.spawn>>();

async function runMessage(
  sessionId: number,
  messageId: number,
  prompt: string,
  claudeSessionId: string,
  isResume: boolean
) {
  const channel = `session_${sessionId}`;

  const notify = async (type: string, data: any) => {
    const payload = JSON.stringify({ type, messageId, ...data, ts: Date.now() });
    await sql`SELECT pg_notify(${channel}, ${payload})`;
  };

  try {
    await sql`UPDATE session_messages SET status = 'running' WHERE id = ${messageId}`;
    await notify("status", { status: "running" });

    const args = [
      "claude",
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--session-id", claudeSessionId,
    ];

    // --resume tells claude to continue the existing conversation
    if (isResume) {
      args.push("--resume");
    }

    const proc = Bun.spawn(args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "upend",
        DISABLE_PROMPT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    activeProcesses.set(sessionId, proc);

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      fullOutput += chunk;

      for (const line of chunk.split("\n").filter(Boolean)) {
        await notify("chunk", { raw: line });
      }
    }

    const exitCode = await proc.exited;
    activeProcesses.delete(sessionId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      await sql`UPDATE session_messages SET status = 'error', result = ${stderr} WHERE id = ${messageId}`;
      await notify("status", { status: "error", error: stderr });
      return;
    }

    await sql`UPDATE session_messages SET status = 'complete', result = ${fullOutput} WHERE id = ${messageId}`;
    await notify("status", { status: "complete" });

    restartServices();

  } catch (err: any) {
    activeProcesses.delete(sessionId);
    await sql`UPDATE session_messages SET status = 'error', result = ${err.message} WHERE id = ${messageId}`;
    await notify("status", { status: "error", error: err.message });
  }
}

function restartServices() {
  if (process.env.NODE_ENV === "production") {
    Bun.spawn(["bash", "-c", `
      for svc in $(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('infra/services.json','utf8'))).filter(s=>s!=='claude').join(' '))"); do
        sudo systemctl restart "upend@$svc"
      done
    `], { cwd: PROJECT_ROOT, stdout: "inherit", stderr: "inherit" });
  }
}

const port = Number(process.env.CLAUDE_PORT) || 3002;
console.log(`[claude] running on :${port}`);

export default { port, fetch: app.fetch };
