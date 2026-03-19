// @cron 0 13 * * *
// @description greet the current user on Slack with a random goodbye phrase

import { sql } from "../lib/db";
import { notify } from "../lib/notify";

export async function run() {
  const [goodbye] = await sql`SELECT * FROM goodbyes ORDER BY random() LIMIT 1`;
  const [owner] = await sql`SELECT email FROM users WHERE id = ${process.env.OWNER_ID ?? "a2a2a0f5-07a8-4f68-a9c2-f83cd219fb3e"}`;

  const user = owner?.email ?? "friend";
  const message = `Hey ${user}! ${goodbye.phrase} (${goodbye.language})`;

  await notify({
    webhook: process.env.SLACK_WEBHOOK_URL,
    payload: {
      message,
      url: "https://alpha.upend.site",
    },
  });

  console.log("Slack message sent:", message);
}

run().then(() => process.exit(0));
