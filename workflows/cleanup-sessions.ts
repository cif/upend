// @cron 0 */6 * * *
// @description clean up ended sessions older than 7 days

import { sql } from "../lib/db";

export async function run() {
  const deleted = await sql`
    DELETE FROM upend.editing_sessions
    WHERE status = 'ended' AND created_at < now() - interval '7 days'
    RETURNING id
  `;
  console.log(`cleaned up ${deleted.length} old sessions`);
}

run().then(() => process.exit(0));
