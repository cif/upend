// upend entry point — starts all services + caddy reverse proxy

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
console.log(`   http://localhost:4000/claude/ui/ → chat with claude`);
console.log(`   http://localhost:4000/api/       → api`);
console.log(`   http://localhost:4000/            → api (default)\n`);
