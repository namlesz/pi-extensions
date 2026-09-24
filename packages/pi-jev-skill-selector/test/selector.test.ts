import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import skillSelector, { buildQuestions, readConfig, selectSkills } from "../src/index.ts";
import { askJev, DECISIONS_URL, JEV_MODEL } from "../src/jev.ts";

const skill = (name: string, disableModelInvocation = false): Skill => ({
  name,
  description: `${name} description`,
  filePath: `/${name}/SKILL.md`,
  baseDir: `/${name}`,
  sourceInfo: { path: `/${name}`, source: "test", scope: "temporary", origin: "top-level" },
  disableModelInvocation,
});

const response = (answers: unknown, status = 200) =>
  new Response(JSON.stringify({ answers }), { status, headers: { "Content-Type": "application/json" } });

test("selection applies threshold, ordering, deduplication, and three-skill limit", () => {
  const skills = [skill("a"), skill("b"), skill("a"), skill("c"), skill("d")];
  const selection = selectSkills(
    skills,
    {
      skill_0: { type: "noul", noul: 0.6 },
      skill_1: { type: "noul", noul: 0.95 },
      skill_2: { type: "noul", noul: 0.9 },
      skill_3: { type: "noul", noul: 0.8 },
      skill_4: { type: "noul", noul: 0.7 },
    },
    0.6,
  );
  assert.equal(selection.primary?.name, "b");
  assert.deepEqual(selection.supporting.map(({ name }) => name), ["a", "c"]);
  assert.deepEqual(selection.skills.map(({ name }) => name), ["b", "a", "c"]);
  assert.deepEqual(
    selection.ranked.map(({ skill, probability }) => [skill.name, probability]),
    [["b", 0.95], ["a", 0.9], ["c", 0.8]],
  );
});

test("selection may be empty", () => {
  assert.deepEqual(
    selectSkills([skill("a")], { skill_0: { type: "noul", noul: 0.59 } }, 0.6).skills,
    [],
  );
});

test("configuration accepts valid values and defaults invalid values", () => {
  assert.deepEqual(
    readConfig({
      PI_SKILL_SELECTOR_THRESHOLD: "0",
      PI_SKILL_SELECTOR_TIMEOUT_MS: "25",
      PI_SKILL_SELECTOR_ALWAYS_VISIBLE: " pi-subagents, docs,pi-subagents ",
    }),
    { threshold: 0, timeoutMs: 25, alwaysVisible: ["pi-subagents", "docs"], enabled: true },
  );
  assert.deepEqual(
    readConfig({ PI_SKILL_SELECTOR_THRESHOLD: "2", PI_SKILL_SELECTOR_TIMEOUT_MS: "1.5" }),
    { threshold: 0.6, timeoutMs: 3000, alwaysVisible: ["pi-subagents"], enabled: true },
  );
  assert.deepEqual(readConfig({ PI_SKILL_SELECTOR_ALWAYS_VISIBLE: "" }).alwaysVisible, []);
  assert.equal(readConfig({ PI_SKILL_SELECTOR_ENABLED: "0" }).enabled, false);
});

test("Jev request passes Polish and English prompts unchanged", async () => {
  for (const prompt of ["Napraw błąd logowania", "Fix the login bug"]) {
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(url, DECISIONS_URL);
      request = init;
      return response({ skill_0: { type: "noul", noul: 0.8 } });
    };
    await askJev("secret", prompt, buildQuestions([skill("debug")]), 100, fetcher);
    const body = JSON.parse(String(request?.body));
    assert.equal(body.model, JEV_MODEL);
    assert.equal(body.state, prompt);
    assert.equal(request?.headers instanceof Headers ? request.headers.get("Authorization") : (request?.headers as Record<string, string>).Authorization, "Bearer secret");
  }
});

test("Jev rejects malformed, incomplete, unknown, out-of-range, HTTP, and network failures", async () => {
  const questions = buildQuestions([skill("a")]);
  const failures: Array<typeof fetch> = [
    async () => response({}),
    async () => response({ skill_0: { type: "choice", noul: 0.8 } }),
    async () => response({ skill_0: { type: "noul", noul: 2 } }),
    async () => response({ skill_0: { type: "noul", noul: 0.8 }, unknown: { type: "noul", noul: 0.2 } }),
    async () => response({}, 500),
    async () => { throw new Error("offline"); },
  ];
  for (const fetcher of failures) {
    await assert.rejects(askJev("secret", "prompt", questions, 100, fetcher));
  }
});

test("Jev aborts at the configured timeout", async () => {
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  await assert.rejects(askJev("secret", "prompt", buildQuestions([skill("a")]), 5, fetcher), /timed out/);
});

test("Jev does not start a request when the parent signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return response({}); };
  await assert.rejects(askJev("secret", "prompt", buildQuestions([skill("a")]), 100, fetcher, controller.signal), /cancelled/);
  assert.equal(called, false);
});
test("extension filters candidates and adds mandatory instruction only for a non-empty success", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "secret";
  globalThis.fetch = async () => response({ skill_0: { type: "noul", noul: 0.8 }, skill_1: { type: "noul", noul: 0.7 } });
  try {
    const statuses: Array<string | undefined> = [];
    const entries: Array<{ customType: string; data: any }> = [];
    const handler = captureHandler(entries);
    const options = { skills: [skill("chosen"), skill("supporting"), skill("explicit", true)], sections: {} as Record<string, string> };
    await handler({ prompt: "task", systemPromptOptions: options }, context("tui", statuses));
    assert.deepEqual(options.skills.map(({ name }) => name), ["chosen", "supporting"]);
    assert.match(options.sections.jev_skill_selector, /must follow them/);
    assert.equal(statuses.at(-1), "jev-skill-selector: (80%) chosen [primary], (70%) supporting [supporting]");
    assert.deepEqual(entries.at(-1), {
      customType: "jev_skill_selector",
      data: {
        status: "success",
        selected: [{ name: "chosen", probability: 0.8 }, { name: "supporting", probability: 0.7 }],
        alwaysVisible: [],
      },
    });
    globalThis.fetch = async () => response({ skill_0: { type: "noul", noul: 0.1 }, skill_1: { type: "noul", noul: 0.1 } });
    await handler({ prompt: "task", systemPromptOptions: options }, context());
    assert.deepEqual(options.skills, []);
    assert.equal(options.sections.jev_skill_selector, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("always-visible skills bypass Jev, stay optional, and sit outside the selection limit", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalAlways = process.env.PI_SKILL_SELECTOR_ALWAYS_VISIBLE;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "secret";
  process.env.PI_SKILL_SELECTOR_ALWAYS_VISIBLE = "pi-subagents";
  let requestBody: any;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return response({ skill_0: { type: "noul", noul: 0.1 } });
  };
  try {
    const statuses: Array<string | undefined> = [];
    const handler = captureHandler();
    const options = {
      skills: [skill("routed"), skill("pi-subagents")],
      sections: {} as Record<string, string>,
    };
    await handler({ prompt: "task", systemPromptOptions: options }, context("tui", statuses));
    assert.deepEqual(Object.keys(requestBody.questions), ["skill_0"]);
    assert.deepEqual(options.skills.map(({ name }) => name), ["pi-subagents"]);
    assert.match(options.sections.jev_skill_selector, /Always-visible optional skills: pi-subagents/);
    assert.doesNotMatch(options.sections.jev_skill_selector, /Mandatory skills/);
    assert.equal(statuses.at(-1), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalAlways === undefined) delete process.env.PI_SKILL_SELECTOR_ALWAYS_VISIBLE;
    else process.env.PI_SKILL_SELECTOR_ALWAYS_VISIBLE = originalAlways;
  }
});

test("extension falls back to the complete skill list and clears stale instructions", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "secret";
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const entries: Array<{ customType: string; data: any }> = [];
    const handler = captureHandler(entries);
    const all = [skill("normal"), skill("explicit", true)];
    const options = { skills: all, sections: { jev_skill_selector: "stale" } as Record<string, string> };
    await handler({ prompt: "task", systemPromptOptions: options }, context());
    assert.deepEqual(options.skills, all);
    assert.equal(options.sections.jev_skill_selector, undefined);
    assert.deepEqual(entries.at(-1), {
      customType: "jev_skill_selector",
      data: { status: "failure", error: "offline" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("routing uses the latest user message on the active branch as context", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "secret";
  let state: unknown;
  globalThis.fetch = async (_url, init) => {
    state = JSON.parse(String(init?.body)).state;
    return response({ skill_0: { type: "noul", noul: 0.9 } });
  };
  try {
    const handler = captureHandler();
    const options = { skills: [skill("debug")], sections: {} as Record<string, string> };
    await handler({ prompt: "Zrób to", systemPromptOptions: options }, context("print", [], [
      { type: "message", message: { role: "user", content: "Stary temat" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Napraw logowanie" }] } },
    ]));
    assert.deepEqual(state, { previousUserMessage: "Napraw logowanie", currentUserMessage: "Zrób to" });
    assert.deepEqual(options.skills.map(({ name }) => name), ["debug"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("images keep all skills without sending the prompt to Jev", async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "secret";
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not call Jev"); };
  try {
    const handler = captureHandler();
    const all = [skill("visual"), skill("explicit", true)];
    const options = { skills: all, sections: {} as Record<string, string> };
    await handler({ prompt: "Co tu widzisz?", images: [{ type: "image", mimeType: "image/png", data: "AA==" }], systemPromptOptions: options }, context());
    assert.deepEqual(options.skills, all);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

test("routing can be disabled explicitly without sending prompts to Jev", async () => {
  const originalEnabled = process.env.PI_SKILL_SELECTOR_ENABLED;
  const originalFetch = globalThis.fetch;
  process.env.PI_SKILL_SELECTOR_ENABLED = "0";
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not call Jev"); };
  try {
    const handler = captureHandler();
    const all = [skill("private")];
    const options = { skills: all, sections: {} as Record<string, string> };
    await handler({ prompt: "private data", systemPromptOptions: options }, context());
    assert.deepEqual(options.skills, all);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnabled === undefined) delete process.env.PI_SKILL_SELECTOR_ENABLED;
    else process.env.PI_SKILL_SELECTOR_ENABLED = originalEnabled;
  }
});

function captureHandler(entries: Array<{ customType: string; data: any }> = []): (event: any, ctx: any) => Promise<void> {
  let handler: ((event: any, ctx: any) => Promise<void>) | undefined;
  skillSelector({
    on: (_name: string, value: typeof handler) => { handler = value; },
    appendEntry: (customType: string, data: any) => { entries.push({ customType, data }); },
  } as any);
  assert.ok(handler);
  return handler;
}
function context(mode = "print", statuses: Array<string | undefined> = [], branch: unknown[] = []) {
  return {
    mode,
    signal: undefined,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    },
  };
}
