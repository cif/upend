import { log } from "../lib/log";
import { exec } from "../lib/exec";
import { readFileSync, writeFileSync } from "fs";

export default async function env(args: string[]) {
  const [key, value] = args;

  if (!key || !value) {
    log.error("usage: upend env:set <KEY> <VALUE>");
    log.dim("  e.g. upend env:set ANTHROPIC_API_KEY sk-ant-...");
    process.exit(1);
  }

  // decrypt
  log.info("decrypting .env...");
  await exec(["bunx", "@dotenvx/dotenvx", "decrypt"], { silent: true });

  // read, update, write
  const envFile = readFileSync(".env", "utf-8");
  const regex = new RegExp(`^${key}=.*$`, "m");

  let updated: string;
  if (regex.test(envFile)) {
    updated = envFile.replace(regex, `${key}="${value}"`);
  } else {
    updated = envFile.trimEnd() + `\n${key}="${value}"\n`;
  }
  writeFileSync(".env", updated);
  log.success(`${key} set`);

  // re-encrypt
  log.info("encrypting .env...");
  await exec(["bunx", "@dotenvx/dotenvx", "encrypt"], { silent: true });
  log.success(".env encrypted");
}
