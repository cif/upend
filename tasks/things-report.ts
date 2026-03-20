// @cron */20 * * * *
// @description report total and shipped things count to Slack every 20 minutes

import { sql } from "../lib/db";
import { notify } from "../lib/notify";

export async function run() {
  const [{ total, shipped }] = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE shipped = true) AS shipped
    FROM things
  `;

  const message = `Things report: ${shipped} shipped / ${total} total`;

  await notify({
    webhook: process.env.SLACK_WEBHOOK_URL,
    payload: { message },
  });

  console.log("Sent:", message);
}

run().then(() => process.exit(0));
