import { Hono } from "hono";
import { sql } from "../../lib/db";
import Anthropic from "@anthropic-ai/sdk";

const app = new Hono();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /services/goodbyes/random — return a random goodbye
app.get("/random", async (c) => {
  const [row] = await sql`SELECT * FROM goodbyes ORDER BY random() LIMIT 1`;
  if (!row) return c.json({ error: "no goodbyes yet" }, 404);
  return c.json(row);
});

// POST /services/goodbyes/discover — ask Claude for a random goodbye, save it, return it
app.post("/discover", async (c) => {
  // Get existing languages so Claude picks a new one
  const existing = await sql`SELECT language FROM goodbyes`;
  const known = existing.map((r: any) => r.language).join(", ");

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 128,
    messages: [
      {
        role: "user",
        content: `Pick a language NOT in this list (${known || "none yet"}) and give me the most common way to say goodbye in it.
Return ONLY valid JSON with these keys: language, phrase, romanization (romanization is null for latin-script languages).
Example: {"language":"Japanese","phrase":"さようなら","romanization":"Sayōnara"}`,
      },
    ],
  });

  const text = (message.content[0] as { type: string; text: string }).text.trim();
  let data: { language: string; phrase: string; romanization: string | null };
  try {
    data = JSON.parse(text);
  } catch {
    return c.json({ error: "failed to parse Claude response", raw: text }, 500);
  }

  const [row] = await sql`
    INSERT INTO goodbyes (language, phrase, romanization)
    VALUES (${data.language}, ${data.phrase}, ${data.romanization ?? null})
    RETURNING *
  `;
  return c.json(row, 201);
});

export default app;
