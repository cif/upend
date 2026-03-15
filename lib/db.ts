import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL!, {
  // max connections — vertical scaling means we can be generous
  max: 20,
  // idle timeout in seconds
  idle_timeout: 20,
  // connect timeout
  connect_timeout: 10,
  // transform column names to camelCase in results
  transform: postgres.camel,
  // log queries in dev
  onnotice: (notice) => console.log("pg:", notice.message),
});

// subscribe to pg NOTIFY for realtime log streaming
export async function listen(channel: string, fn: (payload: string) => void) {
  await sql.listen(channel, fn);
}
