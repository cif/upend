// upend entry point — starts all services
// For single-service dev, run: bun --watch services/<name>/index.ts

const services = await Bun.file("infra/services.json").json();

for (const [name, config] of Object.entries(services) as [string, any][]) {
  console.log(`starting ${name} → ${config.entry}`);
  Bun.spawn(["bun", config.entry], {
    env: { ...process.env, [config.env]: String(config.port) },
    stdout: "inherit",
    stderr: "inherit",
  });
}
