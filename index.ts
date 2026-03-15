// upend entry point — starts all services + caddy + drizzle studio

const services = await Bun.file("infra/services.json").json() as Record<string, { entry: string; port: number; env: string }>;

// start each service with --watch for hot reload
for (const [name, config] of Object.entries(services)) {
  console.log(`starting ${name} → ${config.entry} (:${config.port})`);
  Bun.spawn(["bun", "--watch", config.entry], {
    env: { ...process.env, [config.env]: String(config.port) },
    stdout: "inherit",
    stderr: "inherit",
  });
}

// start drizzle studio on :4983
console.log("starting drizzle studio → :4983");
Bun.spawn(["bunx", "drizzle-kit", "studio", "--port", "4983", "--verbose"], {
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});

// start caddy with the dev config
const caddyfile = process.env.NODE_ENV === "production"
  ? "infra/Caddyfile"
  : "infra/Caddyfile.dev";

console.log(`starting caddy → ${caddyfile}`);
Bun.spawn(["caddy", "run", "--config", caddyfile], {
  stdout: "inherit",
  stderr: "inherit",
});

console.log(`\n🔥 upend running on :4000`);
console.log(`   http://localhost:4000/          → dashboard`);
console.log(`   http://localhost:4000/api/      → api`);
console.log(`   http://localhost:4000/claude/   → chat with claude`);
console.log(`   http://localhost:4000/studio/   → drizzle studio`);
console.log(`   http://localhost:4000/apps/     → live apps\n`);
