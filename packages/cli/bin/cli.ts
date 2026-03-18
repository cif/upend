#!/usr/bin/env bun

const args = process.argv.slice(2);
const command = args[0];

const commands: Record<string, () => Promise<void>> = {
  init: () => import("../src/commands/init").then((m) => m.default(args.slice(1))),
  dev: () => import("../src/commands/dev").then((m) => m.default(args.slice(1))),
  deploy: () => import("../src/commands/deploy").then((m) => m.default(args.slice(1))),
  migrate: () => import("../src/commands/migrate").then((m) => m.default(args.slice(1))),
  infra: () => import("../src/commands/infra").then((m) => m.default(args.slice(1))),
};

if (!command || command === "--help" || command === "-h") {
  console.log(`
  upend — anti-SaaS stack

  usage:
    upend init <name>        scaffold a new project
    upend dev                start local dev (services + caddy)
    upend deploy             deploy to remote instance
    upend migrate            run database migrations
    upend infra:aws          provision AWS infrastructure
    upend infra:gcp          provision GCP infrastructure

  options:
    --help, -h               show this help
    --version, -v            show version
`);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  console.log(pkg.version);
  process.exit(0);
}

// handle infra:provider syntax
const cmd = command.startsWith("infra:") ? "infra" : command;

if (!commands[cmd]) {
  console.error(`unknown command: ${command}`);
  console.error(`run 'upend --help' for usage`);
  process.exit(1);
}

await commands[cmd]();
