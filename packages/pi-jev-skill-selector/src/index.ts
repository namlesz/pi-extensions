import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { askJev, type JevAnswers, type JevQuestions } from "./jev.ts";

const ROUTER_SECTION = "jev_skill_selector";

export interface RankedSkill {
  skill: Skill;
  probability: number;
}

export interface Selection {
  primary?: Skill;
  supporting: Skill[];
  skills: Skill[];
  ranked: RankedSkill[];
}

export function buildQuestions(skills: Skill[]): JevQuestions {
  return Object.fromEntries(
    skills.map((skill, index) => [
      `skill_${index}`,
      {
        type: "noul" as const,
        instructions: `Is the skill "${skill.name}" required to complete the current task correctly?`,
        criteria: {
          false: `The task can be completed correctly without ${skill.name}.`,
          true: `${skill.name} is required: ${skill.description}`,
        },
      },
    ]),
  );
}

export function selectSkills(skills: Skill[], answers: JevAnswers, threshold: number): Selection {
  const seen = new Set<string>();
  const ranked = skills
    .map((skill, index) => ({ skill, probability: answers[`skill_${index}`].noul }))
    .filter(({ probability }) => probability >= threshold)
    .sort((a, b) => b.probability - a.probability)
    .filter(({ skill }) => !seen.has(skill.name) && Boolean(seen.add(skill.name)))
    .slice(0, 3);
  const selected = ranked.map(({ skill }) => skill);

  return { primary: selected[0], supporting: selected.slice(1), skills: selected, ranked };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): {
  threshold: number;
  timeoutMs: number;
  alwaysVisible: string[];
  enabled: boolean;
} {
  return {
    threshold: numberInRange(env.PI_SKILL_SELECTOR_THRESHOLD, 0, 1, 0.6),
    timeoutMs: positiveInteger(env.PI_SKILL_SELECTOR_TIMEOUT_MS, 3000),
    alwaysVisible: [...new Set((env.PI_SKILL_SELECTOR_ALWAYS_VISIBLE ?? "pi-subagents").split(",").map((name) => name.trim()).filter(Boolean))],
    enabled: env.PI_SKILL_SELECTOR_ENABLED !== "0",
  };
}

export default function skillSelector(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const allSkills = [...event.systemPromptOptions.skills];
    const { threshold, timeoutMs, alwaysVisible: alwaysVisibleNames, enabled } = readConfig();
    const alwaysVisibleSet = new Set(alwaysVisibleNames);
    const alwaysVisible = allSkills.filter((skill) => alwaysVisibleSet.has(skill.name));
    const candidates = allSkills.filter(
      (skill) => !skill.disableModelInvocation && !alwaysVisibleSet.has(skill.name),
    );
    delete event.systemPromptOptions.sections[ROUTER_SECTION];

    if (!enabled || event.images?.length) {
      pi.appendEntry(ROUTER_SECTION, { status: "skipped", reason: enabled ? "images" : "disabled_by_user" });
      if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, undefined);
      return;
    }

    if (candidates.length === 0) {
      event.systemPromptOptions.skills = alwaysVisible;
      setRouterSection(event.systemPromptOptions.sections, [], alwaysVisible);
      pi.appendEntry(ROUTER_SECTION, {
        status: "skipped",
        reason: "no_candidates",
        alwaysVisible: alwaysVisible.map(({ name }) => name),
      });
      if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, statusText([]));
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      pi.appendEntry(ROUTER_SECTION, { status: "disabled", reason: "missing_api_key" });
      warn(ctx, "Skill routing disabled: OPENROUTER_API_KEY is missing");
      return;
    }

    if (ctx.mode === "tui") ctx.ui.setStatus(ROUTER_SECTION, "routing skills…");

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
      const selection = selectSkills(candidates, answers, threshold);
      event.systemPromptOptions.skills = [...selection.skills, ...alwaysVisible];
      setRouterSection(event.systemPromptOptions.sections, selection.skills, alwaysVisible);
      pi.appendEntry(ROUTER_SECTION, {
        status: "success",
        selected: selection.ranked.map(({ skill, probability }) => ({ name: skill.name, probability })),
        alwaysVisible: alwaysVisible.map(({ name }) => name),
      });
      if (ctx.mode === "tui") {
        ctx.ui.setStatus(ROUTER_SECTION, statusText(selection.ranked));
      }
    } catch (error) {
      event.systemPromptOptions.skills = allSkills;
      pi.appendEntry(ROUTER_SECTION, { status: "failure", error: errorMessage(error) });
      warn(ctx, `Skill routing failed; using all skills (${errorMessage(error)})`);
    }
  });
}

function setRouterSection(sections: Record<string, string>, selected: Skill[], alwaysVisible: Skill[]): void {
  const lines: string[] = [];
  if (selected.length > 0) {
    lines.push(
      `Mandatory skills selected for the current task: ${selected.map((skill) => skill.name).join(", ")}. You must follow them. Read each selected SKILL.md unless its instructions are already present in the conversation context.`,
    );
  }
  if (alwaysVisible.length > 0) {
    lines.push(
      `Always-visible optional skills: ${alwaysVisible.map((skill) => skill.name).join(", ")}. Decide whether to use them for the current task.`,
    );
  }
  if (lines.length > 0) sections[ROUTER_SECTION] = lines.join("\n");
}

function statusText(selected: RankedSkill[]): string | undefined {
  if (selected.length === 0) return undefined;
  return `jev-skill-selector: ${selected
    .map(({ skill, probability }, index) =>
      `(${Math.round(probability * 100)}%) ${skill.name} [${index === 0 ? "primary" : "supporting"}]`,
    )
    .join(", ")}`;
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
