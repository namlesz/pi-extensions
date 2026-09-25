import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { askJev, CHECK_NAMES, MAX_TIMEOUT_MS, redactSecrets, type CheckName, type JevAnswers } from "./jev.ts";

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_STATE_CHARS = 20_000;
const DISPLAY_ARGS_CHARS = 1_200;

export interface GuardConfig {
  threshold: number;
  timeoutMs: number;
}

export function readConfig(env: Record<string, string | undefined> = process.env): GuardConfig {
  const threshold = Number(env.PI_JEV_GUARD_THRESHOLD);
  const timeoutMs = Number(env.PI_JEV_GUARD_TIMEOUT_MS);
  return {
    threshold: validNumber(env.PI_JEV_GUARD_THRESHOLD, threshold, 0, 1, DEFAULT_THRESHOLD),
    timeoutMs: validNumber(env.PI_JEV_GUARD_TIMEOUT_MS, timeoutMs, 100, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export default function jevGuard(
  pi: ExtensionAPI,
  fetcher: typeof fetch = fetch,
  allowPath = join(homedir(), ".pi", "agent", "jev-guard-allow.json"),
): void {
  let disabledSessionId: string | undefined;
  const restore = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    disabledSessionId = ctx.sessionManager.getEntries().some((entry) =>
      entry.type === "custom" && entry.customType === "jev-guardian-disabled" && (entry.data as { sessionId?: string } | undefined)?.sessionId === sessionId
    ) ? sessionId : undefined;
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  const disable = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    pi.appendEntry("jev-guardian-disabled", { sessionId });
    disabledSessionId = sessionId;
  };
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = event.input.command;
    if (typeof command !== "string") return { block: true, reason: "Blocked: shell command is missing." };
    if (disabledSessionId === ctx.sessionManager.getSessionId()) return;
    try {
      const allowed = readAllowed(allowPath);
      if (isAllowed(command, allowed, event.toolName)) return;
    } catch {
      return decision(pi, ctx, event, "Cannot read the command allowlist. Choose whether to proceed.", disable);
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      return decision(pi, ctx, event, "JEV is unavailable: OPENROUTER_API_KEY is not set. Choose whether to proceed.", disable, allowPath);
    }

    const config = readConfig();
    let answers: JevAnswers;
    try {
      const state = makeState(latestUserGoal(ctx), event);
      answers = await askJev(apiKey, state, config.timeoutMs, fetcher, ctx.signal);
    } catch {
      return decision(pi, ctx, event, "JEV could not assess this call (request failure, timeout, or invalid response). Choose whether to proceed.", disable, allowPath);
    }
    const flagged = CHECK_NAMES.filter((name) => answers[name].noul >= config.threshold);
    if (flagged.length === 0) return;
    const summary = flagged.map((name) => `${label(name)} (${Math.round(answers[name].noul * 100)}%)`).join(", ");
    return decision(pi, ctx, event, `JEV flagged: ${summary}. Choose whether to proceed.`, disable, allowPath, answers, flagged);
  });
}

type Shell = "bash" | "powershell";
type Allowlist = Record<Shell | `${Shell}Patterns`, string[]>;
const EMPTY_ALLOWLIST = (): Allowlist => ({ bash: [], powershell: [], bashPatterns: [], powershellPatterns: [] });

function isAllowed(command: string, allowed: Allowlist, tool: Shell): boolean {
  if (allowed[tool].includes(command)) return true;
  // Only recognize plain words and simple chains; anything shell-dependent is assessed as a whole by JEV.
  const parts = command.split(/;|&&|\|\||\r?\n/);
  return parts.every((part) => {
    const simple = part.trim();
    return /^[A-Za-z0-9_./:@%+=, \t-]+$/.test(simple) && (
      allowed[tool].includes(simple) || allowed[`${tool}Patterns`].some((pattern) => matchesPattern(simple, pattern))
    );
  });
}

function matchesPattern(command: string, pattern: string): boolean {
  if (!pattern.includes("*")) return command === pattern;
  const [first = "", ...rest] = pattern.split("*");
  if (!command.startsWith(first)) return false;
  let offset = first.length;
  const last = rest.pop() ?? "";
  for (const part of rest) {
    const index = command.indexOf(part, offset);
    if (index < 0) return false;
    offset = index + part.length;
  }
  return command.slice(offset).endsWith(last);
}

function readAllowed(path: string): Allowlist {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_ALLOWLIST();
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid command allowlist");
  const entries = Object.entries(value);
  if (entries.some(([tool, commands]) =>
    !Object.hasOwn(EMPTY_ALLOWLIST(), tool) || !Array.isArray(commands) || commands.some((command) => typeof command !== "string")
  )) throw new Error("Invalid command allowlist");
  const allowed = value as Partial<Allowlist>;
  return { ...EMPTY_ALLOWLIST(), ...allowed };
}

async function allowCommand(path: string, tool: Shell, command: string, signal?: AbortSignal): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      await delay(25, undefined, { signal });
    }
  }
  try {
    const allowed = readAllowed(path);
    if (allowed[tool].includes(command)) return;
    allowed[tool].push(command);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(allowed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    rmdirSync(lock);
  }
}


function validNumber(value: string | undefined, parsed: number, min: number, max: number, fallback: number): number {
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function latestUserGoal(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text.trim()) return text;
  }
  return "No user goal was found in the active session.";
}

function makeState(goal: string, event: ToolCallEvent): string {
  const state = JSON.stringify(redactSecrets({ goal, toolName: event.toolName, arguments: event.input }));
  if (!state || state.length > MAX_STATE_CHARS) throw new Error("JEV context exceeds the request limit");
  return state;
}

async function decision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolCallEvent,
  reason: string,
  disable: (ctx: ExtensionContext) => void,
  allowPath?: string,
  answers?: JevAnswers,
  flagged?: CheckName[],
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) return { block: true, reason: "Blocked: approval UI is unavailable." };
  const raised = flagged?.length ? `\nRisk checks: ${flagged.map((name) => `${label(name)} (${Math.round(answers![name].noul * 100)}%)`).join(", ")}` : "";
  const args = safeJson(redactSecrets(event.input));
  const clippedArgs = args.length > DISPLAY_ARGS_CHARS ? `${args.slice(0, DISPLAY_ARGS_CHARS)}…` : args;
  const title = `${reason}${raised}\nTool: ${event.toolName}\nArguments: ${clippedArgs}`;

  pi.events.emit("herdr:blocked", { active: true, label: "JEV guardian: command approval needed" });
  try {
    ctx.ui.notify("JEV guardian: command approval needed", "warning");
    const choices = allowPath ? ["Allow once", "Block", "Always allow", "Disable guardian for this session"] : ["Allow once", "Block", "Disable guardian for this session"];
    const choice = await ctx.ui.select(title, choices, ctx.signal ? { signal: ctx.signal } : undefined);
    if (choice === "Allow once") return;
    if (choice === "Disable guardian for this session") {
      disable(ctx);
      return;
    }
    if (choice === "Always allow" && allowPath && (event.toolName === "bash" || event.toolName === "powershell")) {
      await allowCommand(allowPath, event.toolName, event.input.command as string, ctx.signal);
      return;
    }
    return { block: true, reason: "Blocked by user, cancellation, or missing approval." };
  } catch {
    return { block: true, reason: "Blocked because approval could not be obtained or saved." };
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[arguments unavailable]";
  }
}

function label(name: CheckName): string {
  return name.replaceAll("_", " ");
}
