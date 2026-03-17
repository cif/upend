import { log } from "./log";

export async function exec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; silent?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !opts.silent) {
    log.error(`command failed: ${cmd.join(" ")}`);
    if (stderr.trim()) log.dim(stderr.trim());
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function execOrDie(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
  const { stdout, exitCode, stderr } = await exec(cmd, opts);
  if (exitCode !== 0) {
    log.error(stderr || `${cmd.join(" ")} failed`);
    process.exit(1);
  }
  return stdout;
}

export async function hasCommand(name: string): Promise<boolean> {
  const { exitCode } = await exec(["which", name], { silent: true });
  return exitCode === 0;
}
