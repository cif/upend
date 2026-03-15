import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { sql } from "../../lib/db";
import { verifyToken } from "../../lib/auth";
import { requireAuth } from "../../lib/middleware";
import { snapshot, listSnapshots, restoreSnapshot } from "./snapshots";
import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const app = new Hono();
app.use("*", logger());
app.use("*", cors());

// serve the chat UI (public — auth happens client-side)
app.use("/ui/*", serveStatic({ root: "./services/claude/public", rewriteRequestPath: (p) => p.replace("/ui", "") }));
app.get("/", (c) => c.redirect("/ui/"));

// everything else requires auth
app.use("*", requireAuth);

const PROJECT_ROOT = process.env.UPEND_ROOT || process.cwd();
const APPS_DIR = join(PROJECT_ROOT, "apps");

// ---------- websocket clients ----------

const wsClients = new Map<number, Set<any>>(); // sessionId → Set<ws>

function broadcast(sessionId: number, msg: any) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(data); } catch {}
  }
}

// ---------- sessions ----------

app.post("/sessions", async (c) => {
  const { prompt, force } = await c.req.json();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const user = c.get("user") as { sub: string; email: string };

  const activeSessions = await sql`
    SELECT es.*,
      (SELECT sm.content FROM session_messages sm WHERE sm.session_id = es.id ORDER BY sm.created_at DESC LIMIT 1) as last_message
    FROM editing_sessions es WHERE es.status = 'active' ORDER BY es.created_at DESC
  `;

  if (activeSessions.length > 0 && !force) {
    return c.json({
      error: "active_sessions",
      message: "Active sessions exist. Creating a new one shares the codebase — rollback affects ALL sessions.",
      activeSessions: activeSessions.map((s: any) => ({
        id: s.id, prompt: s.prompt, snapshotName: s.snapshotName, createdAt: s.createdAt, lastMessage: s.lastMessage,
      })),
      options: {
        force: "Send { force: true } to create anyway",
        join: `POST /sessions/${activeSessions[0].id}/messages`,
      },
    }, 409);
  }

  console.log(`[session] new session for ${user.email}: "${prompt.slice(0, 80)}"`);
  const snap = await snapshot(PROJECT_ROOT);
  console.log(`[session] snapshot: ${snap}`);

  const claudeSessionId = crypto.randomUUID();

  const [session] = await sql`
    INSERT INTO editing_sessions (prompt, status, claude_session_id, snapshot_name, context)
    VALUES (${prompt}, 'active', ${claudeSessionId}, ${snap}, ${JSON.stringify({ root: PROJECT_ROOT })})
    RETURNING *
  `;

  const [msg] = await sql`
    INSERT INTO session_messages (session_id, role, content, status)
    VALUES (${session.id}, 'user', ${prompt}, 'pending')
    RETURNING *
  `;

  runMessage(Number(session.id), Number(msg.id), prompt, claudeSessionId, false);

  return c.json({ session, message: msg, snapshot: snap }, 201);
});

app.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const { prompt } = await c.req.json();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const [session] = await sql`SELECT * FROM editing_sessions WHERE id = ${sessionId}`;
  if (!session) return c.json({ error: "session not found" }, 404);
  if (session.status !== "active") return c.json({ error: `session is ${session.status}` }, 400);

  const [running] = await sql`
    SELECT id FROM session_messages WHERE session_id = ${sessionId} AND status = 'running'
  `;
  if (running) return c.json({ error: "a message is already running" }, 409);

  const [msg] = await sql`
    INSERT INTO session_messages (session_id, role, content, status)
    VALUES (${sessionId}, 'user', ${prompt}, 'pending')
    RETURNING *
  `;

  runMessage(Number(sessionId), Number(msg.id), prompt, session.claudeSessionId, true);

  return c.json(msg, 201);
});

app.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const [session] = await sql`SELECT * FROM editing_sessions WHERE id = ${id}`;
  if (!session) return c.json({ error: "not found" }, 404);
  const messages = await sql`SELECT * FROM session_messages WHERE session_id = ${id} ORDER BY created_at`;
  return c.json({ ...session, messages });
});

app.get("/sessions", async (c) => {
  const rows = await sql`SELECT * FROM editing_sessions ORDER BY created_at DESC LIMIT 50`;
  return c.json(rows);
});

app.post("/sessions/:id/end", async (c) => {
  const id = c.req.param("id");
  await sql`UPDATE editing_sessions SET status = 'ended' WHERE id = ${id}`;
  activeProcesses.delete(Number(id));
  return c.json({ ended: true });
});

app.post("/sessions/:id/kill", async (c) => {
  const id = Number(c.req.param("id"));
  const proc = activeProcesses.get(id);
  if (!proc) return c.json({ error: "nothing running" }, 404);
  proc.kill();
  activeProcesses.delete(id);
  await sql`UPDATE session_messages SET status = 'killed' WHERE session_id = ${id} AND status = 'running'`;
  broadcast(id, { type: "status", status: "killed" });
  return c.json({ killed: true });
});

// ---------- apps ----------

app.get("/apps", async (c) => {
  mkdirSync(APPS_DIR, { recursive: true });
  const apps = readdirSync(APPS_DIR)
    .filter((f) => statSync(join(APPS_DIR, f)).isDirectory())
    .map((name) => ({ name, url: `/apps/${name}/`, created: statSync(join(APPS_DIR, name)).birthtime }));
  return c.json(apps);
});

app.post("/apps", async (c) => {
  const { name, files } = await c.req.json();
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!files || typeof files !== "object") return c.json({ error: "provide files: { 'index.html': '...' }" }, 400);

  const appDir = join(APPS_DIR, name);
  mkdirSync(appDir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(appDir, filename);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content as string);
  }
  return c.json({ app: name, url: `/apps/${name}/`, files: Object.keys(files), live: true }, 201);
});

app.post("/apps/generate", async (c) => {
  const { name, prompt } = await c.req.json();
  if (!name || !prompt) return c.json({ error: "name and prompt required" }, 400);

  const appDir = join(APPS_DIR, name);
  mkdirSync(appDir, { recursive: true });

  const metaPrompt = `Create a self-contained web app in the directory ${appDir}.
The app will be served as static files at /apps/${name}/ — it needs at minimum an index.html.
It can talk to the API at /api/ (same origin). Auth tokens are in localStorage as 'upend_token'.
Use Bearer token in Authorization headers. API endpoints:
- POST /api/auth/signup, /api/auth/login — { email, password } → { user, token }
- GET/POST/PATCH/DELETE /api/data/:table(/:id) — CRUD (requires auth)
Keep it simple. No build step. Vanilla JS unless the prompt asks otherwise.
User's request: ${prompt}`;

  Bun.spawn(
    ["claude", "-p", metaPrompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    { cwd: PROJECT_ROOT, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "upend" }, stdout: "inherit", stderr: "inherit" }
  );

  return c.json({ app: name, url: `/apps/${name}/`, status: "generating" }, 202);
});

// ---------- snapshots / rollback ----------

app.get("/snapshots", async (c) => {
  const snaps = await listSnapshots(PROJECT_ROOT);
  return c.json(snaps);
});

app.post("/rollback", async (c) => {
  const { snapshot: snapName, restoreDb } = await c.req.json();
  if (!snapName) return c.json({ error: "snapshot name required" }, 400);
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
  try {
    await sql`UPDATE session_messages SET status = 'running' WHERE id = ${messageId}`;
    broadcast(sessionId, { type: "status", status: "running", messageId });
    console.log(`[claude:${sessionId}] message ${messageId} → running`);

    const args = [
      "claude", "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (isResume) {
      args.push("--resume", "--session-id", claudeSessionId);
    }

    console.log(`[claude:${sessionId}] spawning: ${args.join(" ")}`);

    const proc = Bun.spawn(args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "upend" },
      stdout: "pipe",
      stderr: "pipe",
    });

    console.log(`[claude:${sessionId}] pid: ${proc.pid}`);
    activeProcesses.set(sessionId, proc);

    // stderr → console
    const stderrReader = proc.stderr.getReader();
    (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        console.error(`[claude:${sessionId}:stderr] ${new TextDecoder().decode(value)}`);
      }
    })();

    // stdout → parse stream-json, store chunks in DB, broadcast to WS
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let fullOutput = "";
    let resultText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      fullOutput += chunk;

      for (const line of chunk.split("\n").filter(Boolean)) {
        console.log(`[claude:${sessionId}:out] ${line.slice(0, 200)}`);

        try {
          const evt = JSON.parse(line);

          // extract text content from assistant messages
          if (evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "text") {
                resultText += block.text;
                // update DB with partial result as it streams
                await sql`UPDATE session_messages SET result = ${resultText} WHERE id = ${messageId}`;
                broadcast(sessionId, { type: "text", text: block.text, messageId });
              } else if (block.type === "tool_use") {
                broadcast(sessionId, { type: "tool_use", name: block.name, input: block.input, messageId });
              }
            }
          }

          // final result
          if (evt.type === "result") {
            resultText = evt.result || resultText;
          }
        } catch {
          // non-JSON line, ignore
        }
      }
    }

    const exitCode = await proc.exited;
    activeProcesses.delete(sessionId);
    console.log(`[claude:${sessionId}] exited code ${exitCode}, ${fullOutput.length} bytes`);

    if (exitCode !== 0) {
      const errMsg = `exit code ${exitCode}: ${resultText || fullOutput.slice(0, 500)}`;
      console.error(`[claude:${sessionId}] ERROR: ${errMsg}`);
      await sql`UPDATE session_messages SET status = 'error', result = ${errMsg} WHERE id = ${messageId}`;
      broadcast(sessionId, { type: "status", status: "error", error: errMsg, messageId });
      return;
    }

    await sql`UPDATE session_messages SET status = 'complete', result = ${resultText} WHERE id = ${messageId}`;
    broadcast(sessionId, { type: "status", status: "complete", messageId });
    console.log(`[claude:${sessionId}] complete: "${resultText.slice(0, 100)}"`);

    restartServices();

  } catch (err: any) {
    console.error(`[claude:${sessionId}] EXCEPTION:`, err);
    activeProcesses.delete(sessionId);
    await sql`UPDATE session_messages SET status = 'error', result = ${err.message} WHERE id = ${messageId}`;
    broadcast(sessionId, { type: "status", status: "error", error: err.message, messageId });
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

// ---------- bun server with websocket support ----------

const port = Number(process.env.CLAUDE_PORT) || 3002;

const server = Bun.serve({
  port,
  fetch: async (req, server) => {
    const url = new URL(req.url);

    // WebSocket upgrade: /ws/:sessionId?token=xxx
    if (url.pathname.startsWith("/ws/")) {
      const sessionId = Number(url.pathname.split("/")[2]);
      const token = url.searchParams.get("token");

      if (!token || !sessionId) {
        return new Response("missing token or session id", { status: 401 });
      }

      try {
        const payload = await verifyToken(token);
        console.log(`[ws] upgrade: session ${sessionId}, user ${payload.email}`);
        const upgraded = server.upgrade(req, { data: { sessionId, email: payload.email } });
        if (upgraded) return undefined as any;
        return new Response("upgrade failed", { status: 500 });
      } catch {
        return new Response("invalid token", { status: 401 });
      }
    }

    // everything else → hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: {
    open(ws) {
      const { sessionId } = ws.data as { sessionId: number };
      if (!wsClients.has(sessionId)) wsClients.set(sessionId, new Set());
      wsClients.get(sessionId)!.add(ws);
      console.log(`[ws] connected: session ${sessionId} (${wsClients.get(sessionId)!.size} clients)`);
    },
    message(ws, msg) {
      // client can send ping, we don't need anything else
    },
    close(ws) {
      const { sessionId } = ws.data as { sessionId: number };
      wsClients.get(sessionId)?.delete(ws);
      console.log(`[ws] disconnected: session ${sessionId}`);
    },
  },
});

console.log(`[claude] running on :${port} (http + ws)`);
