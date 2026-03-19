// git worktree management for isolated editing sessions

const PROJECT_ROOT = process.env.UPEND_PROJECT || process.cwd();
const SESSIONS_DIR = `${PROJECT_ROOT}/sessions`;

// word lists for generating session names
const adjectives = ["bright","calm","cool","dark","eager","fast","gentle","happy","keen","lively","neat","proud","quick","rare","sharp","swift","warm","wise","bold","crisp"];
const nouns = ["anchor","beacon","castle","delta","ember","falcon","grove","harbor","island","jade","kite","lantern","mesa","north","oasis","peak","quartz","ridge","summit","tide"];

export function generateSessionName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

async function git(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function gitIn(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// create a worktree for a new session
export async function createWorktree(name: string): Promise<{ path: string; branch: string }> {
  const branch = `session/${name}`;
  const worktreePath = `${SESSIONS_DIR}/${name}`;

  // ensure sessions dir exists
  await Bun.spawn(["mkdir", "-p", SESSIONS_DIR]).exited;

  // create branch from current HEAD
  const result = await git("worktree", "add", "-b", branch, worktreePath);
  if (result.exitCode !== 0) {
    throw new Error(`failed to create worktree: ${result.stderr}`);
  }

  // copy gitignored files the worktree needs
  await Bun.spawn(["ln", "-sf", `${PROJECT_ROOT}/node_modules`, `${worktreePath}/node_modules`]).exited;
  await Bun.spawn(["cp", `${PROJECT_ROOT}/.env`, `${worktreePath}/.env`]).exited;
  await Bun.spawn(["cp", `${PROJECT_ROOT}/.env.keys`, `${worktreePath}/.env.keys`]).exited;
  await Bun.spawn(["cp", "-r", `${PROJECT_ROOT}/.keys`, `${worktreePath}/.keys`]).exited;

  console.log(`[worktree] created ${name} at ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

// commit all changes in a worktree
export async function commitWorktree(name: string, message: string): Promise<string> {
  const worktreePath = `${SESSIONS_DIR}/${name}`;
  // exclude files that should never be merged
  await gitIn(worktreePath, "add", "-A", "--", ".", ":!.env", ":!.env.keys", ":!.keys");
  const result = await gitIn(worktreePath, "commit", "-m", message, "--allow-empty");
  console.log(`[worktree] committed ${name}: ${result.stdout}`);
  return result.stdout;
}

// check if a session can merge cleanly into live
export async function checkMergeable(name: string): Promise<{ mergeable: boolean; conflicts: string[]; error?: string }> {
  const branch = `session/${name}`;

  // auto-commit any pending changes in the worktree first
  const worktreePath = `${SESSIONS_DIR}/${name}`;
  await gitIn(worktreePath, "add", "-A", "--", ".", ":!.env", ":!.env.keys", ":!.keys");
  await gitIn(worktreePath, "commit", "-m", `auto-commit before merge check`, "--allow-empty");

  // find the fork point — where this session branched from main
  const baseResult = await git("merge-base", "HEAD", branch);
  if (baseResult.exitCode !== 0) {
    // unrelated histories — find files the session actually changed vs its own root
    // and check if any of those files also differ on main
    const sessionFiles = await gitIn(worktreePath, "diff", "--name-only", "--diff-filter=ACMR", "--no-renames", "HEAD~1");
    if (!sessionFiles.stdout.trim()) {
      return { mergeable: true, conflicts: [] };
    }
    // for each file the session touched, check if main has a different version
    const conflicts: string[] = [];
    for (const file of sessionFiles.stdout.trim().split("\n")) {
      const mainVersion = await git("show", `HEAD:${file}`);
      const sessionVersion = await git("show", `${branch}:${file}`);
      if (mainVersion.exitCode === 0 && sessionVersion.exitCode === 0 && mainVersion.stdout !== sessionVersion.stdout) {
        conflicts.push(file);
      }
    }
    if (conflicts.length > 0) {
      return { mergeable: false, conflicts };
    }
    return { mergeable: true, conflicts: [] };
  }

  // normal case: related histories — use merge-tree (doesn't touch working tree)
  const result = await git("merge-tree", "--write-tree", "HEAD", branch);

  if (result.exitCode === 0) {
    return { mergeable: true, conflicts: [] };
  }

  const conflicts = result.stdout.split("\n")
    .filter(line => /^\d{6} /.test(line))
    .map(line => line.replace(/^\d{6} [a-f0-9]+ \d\t/, ""))
    .filter(Boolean);
  const uniqueConflicts = [...new Set(conflicts)];

  const error = uniqueConflicts.length === 0 ? (result.stderr || result.stdout || "merge failed for unknown reason") : undefined;

  return { mergeable: false, conflicts: uniqueConflicts, error };
}

// merge a session into live (main branch)
export async function mergeToLive(name: string, user: string): Promise<{ success: boolean; message: string }> {
  const branch = `session/${name}`;
  const worktreePath = `${SESSIONS_DIR}/${name}`;

  // commit any pending changes in the worktree (exclude env/secrets)
  await gitIn(worktreePath, "add", "-A", "--", ".", ":!.env", ":!.env.keys", ":!.keys");
  await gitIn(worktreePath, "commit", "-m", `session ${name}: final changes`, "--allow-empty");

  // commit any uncommitted changes on main so git merge can proceed
  // (stashing would modify the working tree and kill the running service)
  const status = await git("status", "--porcelain");
  if (status.stdout) {
    await git("add", "-A");
    await git("commit", "-m", "auto-commit before session merge", "--allow-empty");
  }

  // merge into main
  const result = await git("merge", "--allow-unrelated-histories", branch, "-m", `merge session ${name} (by ${user})`);

  if (result.exitCode !== 0) {
    console.error(`[worktree] merge failed for ${name}: ${result.stderr}`);
    // abort failed merge
    await git("merge", "--abort");
    return { success: false, message: `merge conflict: ${result.stderr}` };
  }

  console.log(`[worktree] merged ${name} into live: ${result.stdout}`);
  return { success: true, message: result.stdout };
}

// clean up a worktree after merge
export async function removeWorktree(name: string): Promise<void> {
  const worktreePath = `${SESSIONS_DIR}/${name}`;
  const branch = `session/${name}`;
  await git("worktree", "remove", worktreePath, "--force");
  await git("branch", "-D", branch);
  console.log(`[worktree] removed ${name}`);
}

// list active worktrees
export async function listWorktrees(): Promise<string[]> {
  const result = await git("worktree", "list", "--porcelain");
  const worktrees = result.stdout.split("\n\n")
    .filter(block => block.includes("/sessions/"))
    .map(block => {
      const match = block.match(/worktree .*\/sessions\/(.+)/);
      return match ? match[1] : null;
    })
    .filter(Boolean) as string[];
  return worktrees;
}

// get the worktree path for a session
export function getWorktreePath(name: string): string {
  return `${SESSIONS_DIR}/${name}`;
}
