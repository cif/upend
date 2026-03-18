import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL!, {
  max: 20,
  idle_timeout: 20,
  connect_timeout: 10,
  transform: postgres.camel,
  onnotice: (notice) => console.log("pg:", notice.message),
});

// subscribe to pg NOTIFY for realtime log streaming
export async function listen(channel: string, fn: (payload: string) => void) {
  await sql.listen(channel, fn);
}
