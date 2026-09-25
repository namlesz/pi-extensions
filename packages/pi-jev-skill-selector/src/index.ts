import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { askJev, type JevAnswers, type JevQuestions } from "./jev.ts";

const ROUTER_SECTION = "jev_skill_selector";

export interface RankedSkill {
  skill: Skill;
  probability: number;
}


export function buildQuestions(skills: Skill[]): JevQuestions {
  return Object.fromEntries(
    skills.map((skill, index) => [
      `skill_${index}`,
      {
        type: "noul" as const,
        instructions: `Would the skill "${skill.name}" offer a specific benefit for the current task, even if it is not required?`,
        criteria: {
          false: `The skill ${skill.name} does not meaningfully help with this task.`,
          true: `The skill ${skill.name} is relevant to a concrete step in this task: ${skill.description}`,
        },
      },
    ]),
  );
}

export function suggestSkills(skills: Skill[], answers: JevAnswers, threshold: number, limit = 3): RankedSkill[] {
  const seen = new Set<string>();
  return skills
    .map((skill, index) => ({ skill, probability: answers[`skill_${index}`].noul }))
    .filter(({ probability }) => probability >= threshold)
    .sort((a, b) => b.probability - a.probability)
    .filter(({ skill }) => !seen.has(skill.name) && Boolean(seen.add(skill.name)))
    .slice(0, limit);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): {
  threshold: number;
  timeoutMs: number;
  enabled: boolean;
} {
  return {
    threshold: numberInRange(env.PI_SELECTOR_THRESHOLD, 0, 1, numberInRange(env.PI_SKILL_SELECTOR_THRESHOLD, 0, 1, 0.7)),
    timeoutMs: positiveInteger(env.PI_SKILL_SELECTOR_TIMEOUT_MS, 3000),
    enabled: env.PI_SKILL_SELECTOR_ENABLED !== "0",
  };
}

function thresholdFile(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "jev-skill-selector-threshold");
}

async function savedThreshold(): Promise<number | undefined> {
  try {
    const value = (await readFile(thresholdFile(), "utf8")).trim();
    const parsed = Number(value);
    return value !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function limitFile(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "jev-skill-selector-limit");
}

async function savedLimit(): Promise<number | undefined> {
  try {
    const value = (await readFile(limitFile(), "utf8")).trim();
    const parsed = Number(value);
    return value !== "" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export default function skillSelector(pi: ExtensionAPI): void {
  pi.registerCommand("skill-threshold", {
    description: "Show or set the persistent skill suggestion threshold (0–100%)",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value && value !== "reset" && (!/^(?:\d+(?:\.\d+)?)$/.test(value) || Number(value) > 100)) {
        ctx.ui.notify("Usage: /skill-threshold [0–100 | reset]", "warning");
        return;
      }
      try {
        if (value === "reset") {
          try { await unlink(thresholdFile()); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } else if (value) {
          const path = thresholdFile();
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, String(Number(value) / 100), "utf8");
        }
        const threshold = await savedThreshold() ?? readConfig().threshold;
        ctx.ui.notify(`Skill suggestion threshold: ${threshold * 100}%`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not update skill threshold: ${errorMessage(error)}`, "error");
      }
    },
  });
  pi.registerCommand("skill-limit", {
    description: "Show or set the persistent maximum number of skill suggestions",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value && value !== "reset" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
        ctx.ui.notify("Usage: /skill-limit [non-negative integer | reset]", "warning");
        return;
      }
      try {
        if (value === "reset") {
          try { await unlink(limitFile()); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } else if (value) {
          const path = limitFile();
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value, "utf8");
        }
        ctx.ui.notify(`Skill suggestion limit: ${await savedLimit() ?? 3}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not update skill limit: ${errorMessage(error)}`, "error");
      }
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const { timeoutMs, enabled, threshold: defaultThreshold } = readConfig();
    const candidates = event.systemPromptOptions.skills.filter((skill) => !skill.disableModelInvocation);
    delete event.systemPromptOptions.sections[ROUTER_SECTION];
    if (!enabled || event.images?.length) {
      pi.appendEntry(ROUTER_SECTION, { status: "skipped", reason: enabled ? "images" : "disabled_by_user" });
      if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, undefined);
      return;
    }
    let threshold: number;
    let limit: number;
    try {
      threshold = await savedThreshold() ?? defaultThreshold;
      limit = await savedLimit() ?? 3;
    } catch (error) {
      pi.appendEntry(ROUTER_SECTION, { status: "failure", error: errorMessage(error) });
      warn(ctx, `Skill suggestions unavailable (${errorMessage(error)})`);
      return;
    }

    if (candidates.length === 0 || limit === 0) {
      pi.appendEntry(ROUTER_SECTION, { status: "skipped", reason: limit === 0 ? "zero_limit" : "no_candidates" });
      if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, undefined);
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      pi.appendEntry(ROUTER_SECTION, { status: "disabled", reason: "missing_api_key" });
      warn(ctx, "Skill suggestions disabled: OPENROUTER_API_KEY is missing");
      return;
    }

    if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, "checking skills…");

    try {
      const previous = ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1);
      let state: string | { previousUserMessage: string; currentUserMessage: string } = event.prompt;
      if (previous?.type === "message" && previous.message.role === "user") {
        const content = previous.message.content;
        const text = typeof content === "string" ? content : content.flatMap((part) => {
          if (part.type === "text") return [part.text];
          return [];
        }).join("\n");
        // ponytail: cap prior context to avoid oversized requests; expand only if routing misses longer tasks.
        if (text.trim()) state = { previousUserMessage: text.slice(0, 2000), currentUserMessage: event.prompt };
      }
      const answers = await askJev(
        apiKey,
        state,
        buildQuestions(candidates),
        timeoutMs,
        fetch,
        ctx.signal,
      );
      const suggestions = suggestSkills(candidates, answers, threshold, limit);
      setSuggestionSection(event.systemPromptOptions.sections, suggestions);
      pi.appendEntry(ROUTER_SECTION, {
        status: "success",
        suggested: suggestions.map(({ skill, probability }) => ({ name: skill.name, probability })),
      });
      if (ctx.mode === "tui") {
        ctx.ui.setStatus(ROUTER_SECTION, statusText(suggestions));
      }
    } catch (error) {
      pi.appendEntry(ROUTER_SECTION, { status: "failure", error: errorMessage(error) });
      warn(ctx, `Skill suggestions unavailable (${errorMessage(error)})`);
    }
  });
}

function setSuggestionSection(sections: Record<string, string>, suggestions: RankedSkill[]): void {
  if (suggestions.length === 0) return;
  sections[ROUTER_SECTION] = `Skills that may be useful: ${suggestions.map(({ skill }) => skill.name).join(", ")}. Consider reading their SKILL.md if relevant. This is an optional hint, not a requirement; follow the user's instructions and choose any available skill independently.`;
}

function statusText(suggestions: RankedSkill[]): string | undefined {
  if (suggestions.length === 0) return undefined;
  return `skill-suggestions: ${suggestions.map(({ skill }) => skill.name).join(", ")}`;
}

function numberInRange(value: string | undefined, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return value !== undefined && Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : fallback;
}

function warn(ctx: { mode: string; ui: { notify(message: string, level: "warning"): void; setStatus(key: string, value: string | undefined): void } }, message: string): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus(ROUTER_SECTION, undefined);
  ctx.ui.notify(message, "warning");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
