import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Projects where complaints are enabled, keyed by absolute project directory. */
export type ProjectStates = Record<string, true>;

export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "self-complaint.json");
}

/** Missing file means nothing is enabled. Invalid content throws so it is never overwritten by mistake. */
export function readStates(path: string): ProjectStates {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid self-complaint state file");
  return Object.fromEntries(Object.entries(value).filter(([, on]) => on === true)) as ProjectStates;
}

export function isEnabled(path: string, cwd: string): boolean {
  return readStates(path)[cwd] === true;
}

export function writeEnabled(path: string, cwd: string, enabled: boolean): void {
  const states = readStates(path);
  if (enabled) states[cwd] = true;
  else delete states[cwd];
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
