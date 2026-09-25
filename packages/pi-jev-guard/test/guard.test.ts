import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import jevGuard, { readConfig } from "../src/index.ts";
import { CHECK_NAMES, DECISIONS_URL, JEV_MODEL, redactSecrets } from "../src/jev.ts";

type Handler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>;
type Choice = "Block" | "Allow once" | "Always allow" | "Disable guardian for this session" | undefined;
type TestSession = { id: string; entries: { type: "custom"; customType: string; data: unknown }[]; branchVisible?: boolean; failWrite?: boolean; start?: (ctx: ExtensionContext) => void; tree?: (ctx: ExtensionContext) => void };
const testDir = mkdtempSync(join(tmpdir(), "jev-guard-"));
after(() => rmSync(testDir, { recursive: true, force: true }));
let nextPath = 0;

const event = (input: Record<string, unknown> = { command: "pwd" }): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: "test-call",
  toolName: "bash",
  input,
});

function extension(fetcher: typeof fetch, allowPath = join(testDir, `${nextPath++}.json`), events: { active: boolean; label?: string }[] = [], session: TestSession = { id: "test-session", entries: [] }): Handler {
  let handler: Handler | undefined;
  jevGuard({
    on: (name: string, callback: Handler | ((_event: unknown, ctx: ExtensionContext) => void)) => {
      if (name === "tool_call") handler = callback as Handler;
      if (name === "session_start") session.start = (ctx) => (callback as (_event: unknown, ctx: ExtensionContext) => void)({}, ctx);
      if (name === "session_tree") session.tree = (ctx) => (callback as (_event: unknown, ctx: ExtensionContext) => void)({}, ctx);
      return () => {};
    },
    appendEntry: (customType: string, data: unknown) => {
      if (session.failWrite) throw new Error("session write failed");
      session.entries.push({ type: "custom", customType, data });
    },
    events: { emit: (name: string, data: { active: boolean; label?: string }) => {
      assert.equal(name, "herdr:blocked");
      events.push(data);
    } },
  } as unknown as ExtensionAPI, fetcher, allowPath);
  assert.ok(handler);
  return handler;
}
function context(options: { goal?: string; hasUI?: boolean; choices?: Choice[]; onSelect?: () => void; session?: TestSession } = {}): ExtensionContext & { selections: string[]; notifications: string[] } {
  const selections: string[] = [];
  const notifications: string[] = [];
  const choices = [...(options.choices ?? ["Block"])];
  return {
    hasUI: options.hasUI ?? true,
    signal: undefined,
    sessionManager: {
      getSessionId: () => options.session?.id ?? "test-session",
      getEntries: () => options.session?.entries ?? [],
      getBranch: () => [
        { type: "message", message: { role: "user", content: [{ type: "text", text: options.goal ?? "Fix the current task." }] } },
        ...(options.session?.branchVisible === false ? [] : options.session?.entries ?? []),
      ],
    },
    ui: {
      notify: (message: string) => { notifications.push(message); },
      select: async (title: string, choicesShown: string[]) => {
        selections.push(title);
        options.onSelect?.();
        assert.deepEqual(choicesShown, title.startsWith("Cannot read the command allowlist") ? ["Block", "Allow once", "Disable guardian for this session"] : ["Block", "Allow once", "Always allow", "Disable guardian for this session"]);
        return choices.shift();
      },
    },
    selections,
    notifications,
  } as unknown as ExtensionContext & { selections: string[]; notifications: string[] };
}

function response(scores: Partial<Record<(typeof CHECK_NAMES)[number], number>> = {}, status = 200): Response {
  const answers = Object.fromEntries(CHECK_NAMES.map((name) => [name, { type: "noul", noul: scores[name] ?? 0.1 }]));
  return new Response(JSON.stringify({ answers }), { status, headers: { "Content-Type": "application/json" } });
}

async function withApiKey<T>(key: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env.OPENROUTER_API_KEY;
  if (key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = key;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = original;
  }
}

test("configuration validates threshold and bounds timeout", () => {
  assert.deepEqual(readConfig({}), { threshold: 0.5, timeoutMs: 3_000 });
  assert.deepEqual(readConfig({ PI_JEV_GUARD_THRESHOLD: "0.7", PI_JEV_GUARD_TIMEOUT_MS: "999999" }), {
    threshold: 0.7,
    timeoutMs: 3_000,
  });
  assert.deepEqual(readConfig({ PI_JEV_GUARD_THRESHOLD: "2", PI_JEV_GUARD_TIMEOUT_MS: "1.5" }), {
    threshold: 0.5,
    timeoutMs: 3_000,
  });
});

test("request uses JEV, sends the four checks, and redacts secret-like fields", async () => {
  let sentState: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, DECISIONS_URL);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    const body = JSON.parse(String(init?.body)) as { model: string; questions: object; state: string };
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(Object.keys(body.questions), ["off_task", "destructive", "untrusted_input", "ask_first"]);
    sentState = JSON.parse(body.state) as Record<string, unknown>;
    return response();
  };
  const handler = extension(fetcher);
  await withApiKey("test-key", async () => {
    const result = await handler(event({
      command: "run script",
      apiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz012345",
      nested: { password: "secret" },
    }), context({ goal: "Run the requested task." }));
    assert.equal(result, undefined);
  });
  assert.equal(sentState?.goal, "Run the requested task.");
  const args = sentState?.arguments as Record<string, unknown>;
  assert.equal(args.apiKey, "[REDACTED]");
  assert.deepEqual(args.nested, { password: "[REDACTED]" });
});

test("a score at threshold prompts once; cancel blocks and Allow once is never cached", async () => {
  const handler = extension(async () => response({ destructive: 0.5 }));
  await withApiKey("test-key", async () => {
    const first = context({ choices: [undefined] });
    assert.deepEqual(await handler(event(), first), {
      block: true,
      reason: "Blocked by user, cancellation, or missing approval.",
    });
    assert.equal(first.selections.length, 1);

    const second = context({ choices: ["Allow once"] });
    assert.equal(await handler(event(), second), undefined);
    assert.equal(second.selections.length, 1);

    const third = context({ choices: ["Block"] });
    assert.ok(await handler(event(), third));
    assert.equal(third.selections.length, 1);
  });
});

test("missing key uses one manual choice; no UI blocks without calling the API", async () => {
  let calls = 0;
  const handler = extension(async () => {
    calls++;
    return response();
  });
  await withApiKey(undefined, async () => {
    const manual = context({ choices: ["Allow once"] });
    assert.equal(await handler(event(), manual), undefined);
    assert.equal(manual.selections.length, 1);

    const noUI = context({ hasUI: false });
    assert.deepEqual(await handler(event(), noUI), { block: true, reason: "Blocked: approval UI is unavailable." });
    assert.equal(noUI.selections.length, 0);
    assert.equal(calls, 0);
  });
});

test("approval alerts Pi and herdr only while waiting for user", async () => {
  const events: { active: boolean; label?: string }[] = [];
  const handler = extension(async () => response(), join(testDir, `${nextPath++}.json`), events);
  await withApiKey(undefined, async () => {
    const ctx = context({ choices: ["Allow once"], onSelect: () => {
      assert.deepEqual(events, [{ active: true, label: "JEV guardian: command approval needed" }]);
    } });
    assert.equal(await handler(event(), ctx), undefined);
    assert.deepEqual(ctx.notifications, ["JEV guardian: command approval needed"]);
    assert.deepEqual(events, [
      { active: true, label: "JEV guardian: command approval needed" },
      { active: false },
    ]);
    events.length = 0;
    assert.ok(await handler(event(), context({ choices: [undefined] })));
    assert.deepEqual(events, [
      { active: true, label: "JEV guardian: command approval needed" },
      { active: false },
    ]);
    events.length = 0;
    assert.ok(await handler(event(), context({ hasUI: false })));
    assert.deepEqual(events, []);
  });
});

test("disable choice bypasses checks only in this session and survives extension reload", async () => {
  const session: TestSession = { id: "first", entries: [] };
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response({ destructive: 0.9 }); };
  const path = join(testDir, `${nextPath++}.json`);
  const handler = extension(fetcher, path, [], session);
  await withApiKey("test-key", async () => {
    const first = context({ session, choices: ["Disable guardian for this session"] });
    assert.equal(await handler(event({ command: "unsafe" }), first), undefined);
    assert.deepEqual(session.entries, [{ type: "custom", customType: "jev-guardian-disabled", data: { sessionId: "first" } }]);
    assert.equal(calls, 1);
    const skipped = context({ session, hasUI: false });
    assert.equal(await handler(event({ command: "another command" }), skipped), undefined);
    assert.equal(skipped.selections.length, 0);
    assert.equal(calls, 1);
    const reloaded = extension(fetcher, path, [], session);
    session.start?.(context({ session }));
    assert.equal(await reloaded(event({ command: "after reload" }), context({ session, hasUI: false })), undefined);
    assert.equal(calls, 1);
    session.branchVisible = false;
    session.tree?.(context({ session }));
    assert.equal(await reloaded(event({ command: "earlier branch" }), context({ session, hasUI: false })), undefined);
    assert.equal(calls, 1);
    session.branchVisible = true; // Fork from the path containing the disable marker.
    session.id = "second"; // A Pi fork copies entries but assigns a new session ID.
    assert.equal(session.entries.length, 1);
    session.start?.(context({ session }));
    const next = context({ session, choices: ["Block"] });
    assert.ok(await reloaded(event({ command: "new session" }), next));
    assert.equal(next.selections.length, 1);
    assert.equal(calls, 2);
  });
});

test("disable with unavailable API fails closed if session state cannot be saved", async () => {
  const session: TestSession = { id: "broken", entries: [], failWrite: true };
  const handler = extension(async () => { throw new Error("should not fetch"); }, undefined, [], session);
  await withApiKey(undefined, async () => {
    assert.deepEqual(await handler(event(), context({ session, choices: ["Disable guardian for this session"] })), {
      block: true, reason: "Blocked because approval could not be obtained or saved.",
    });
    assert.deepEqual(session.entries, []);
    session.failWrite = false;
    const next = context({ session, choices: ["Block"] });
    assert.ok(await handler(event(), next));
    assert.equal(next.selections.length, 1);
  });
});
test("invalid response and timeout require manual approval", async () => {
  const invalid = extension(async () => response({ destructive: 1.01 }));
  await withApiKey("test-key", async () => {
    const manual = context({ choices: ["Allow once"] });
    assert.equal(await invalid(event(), manual), undefined);
    assert.equal(manual.selections.length, 1);

    const serverError = extension(async () => new Response("", { status: 503 }));
    const serverChoice = context({ choices: ["Allow once"] });
    assert.equal(await serverError(event(), serverChoice), undefined);
    assert.equal(serverChoice.selections.length, 1);
    assert.deepEqual(await serverError(event(), context({ hasUI: false })), {
      block: true,
      reason: "Blocked: approval UI is unavailable.",
    });

    const timeout = extension(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const timed = context({ choices: ["Allow once"] });
    const original = process.env.PI_JEV_GUARD_TIMEOUT_MS;
    process.env.PI_JEV_GUARD_TIMEOUT_MS = "100";
    try {
      assert.equal(await timeout(event(), timed), undefined);
      assert.equal(timed.selections.length, 1);
    } finally {
      if (original === undefined) delete process.env.PI_JEV_GUARD_TIMEOUT_MS;
      else process.env.PI_JEV_GUARD_TIMEOUT_MS = original;
    }
  });
});

test("only shell commands reach JEV, and an exact approval persists across handlers", async () => {
  const path = join(testDir, "persistent.json");
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return response({ destructive: 0.9 }); };
  const first = extension(fetcher, path);
  await withApiKey("test-key", async () => {
    const ctx = context({ choices: ["Always allow"] });
    assert.equal(await first(event({ command: "pwd" }), ctx), undefined);
    assert.equal(ctx.selections.length, 1);
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { bash: ["pwd"], powershell: [], bashPatterns: [], powershellPatterns: [] });
  const again = extension(fetcher, path);
  await withApiKey(undefined, async () => {
    assert.equal(await again(event({ command: "pwd" }), context({ hasUI: false })), undefined);
    assert.ok(await again(event({ command: "pwd; echo unexpected" }), context({ hasUI: false })));
    assert.ok(await again({ ...event(), toolName: "powershell" }, context({ hasUI: false })));
    assert.equal(await again({ ...event(), toolName: "read", input: { path: "secret" } }, context({ hasUI: false })), undefined);
  });
  assert.equal(calls, 1);
});

test("manual entries are literal; invalid lists cannot create or save permanent approval", async () => {
  const path = join(testDir, "manual.json");
  writeFileSync(path, JSON.stringify({ bash: ["git *"] }));
  const handler = extension(async () => response({ destructive: 0.9 }), path);
  await withApiKey(undefined, async () => {
    assert.equal(await handler(event({ command: "git *" }), context({ hasUI: false })), undefined);
    assert.ok(await handler(event({ command: "git status" }), context({ hasUI: false })));
    writeFileSync(path, "not json");
    const ctx = context({ choices: ["Allow once"] });
    assert.equal(await handler(event(), ctx), undefined);
    assert.match(ctx.selections[0]!, /Cannot read the command allowlist/);
  });
  assert.equal(readFileSync(path, "utf8"), "not json");
});

test("patterns approve only simple commands and chains whose every segment is approved", async () => {
  const path = join(testDir, "patterns.json");
  writeFileSync(path, JSON.stringify({ bash: ["git status"], bashPatterns: ["npm *", "echo * end"], powershellPatterns: ["Get-*", "Write-Host *"] }));
  const sent: string[] = [];
  const handler = extension(async (_url, init) => {
    const state = JSON.parse(JSON.parse(String(init?.body)).state) as { arguments: { command: string } };
    sent.push(state.arguments.command);
    return response({ destructive: 0.9 });
  }, path);
  await withApiKey("test-key", async () => {
    for (const command of ["npm test", "git status; npm test && echo done end", "npm test\nnpm run lint", "npm test || git status"]) {
      assert.equal(await handler(event({ command }), context({ hasUI: false })), undefined, command);
    }
    assert.equal(await handler({ ...event({ command: "Get-Item; Write-Host done" }), toolName: "powershell" }, context({ hasUI: false })), undefined);
    assert.equal(sent.length, 0);

    for (const command of [
      "npm test; rm -rf x", "npm test && curl example.com", "npm test\nrm -rf x",
      "npm test | sh", "npm test & rm -rf x", "npm test $(rm -rf x)",
      "npm test `rm -rf x`", "npm test > out", "npm test # comment\nrm -rf x",
      "npm test;", "npm test;;git status", "npm test; git status &&",
      "NPM test", "echo x end trailing", "echo /tmp/a\nmore end",
    ]) {
      const ctx = context({ choices: ["Block"] });
      assert.ok(await handler(event({ command }), ctx), command);
      assert.match(ctx.selections[0]!, /JEV flagged/);
      assert.equal(sent.at(-1), command);
    }
    for (const command of ["Get-Item; Remove-Item x", "Get-Item | Remove-Item x", "Get-Item; Write-Host $HOME"]) {
      assert.ok(await handler({ ...event({ command }), toolName: "powershell" }, context({ choices: ["Block"] })), command);
    }
    assert.equal(sent.length, 18);

    const ctx = context({ choices: ["Always allow"] });
    assert.equal(await handler(event({ command: "echo *" }), ctx), undefined);
    assert.equal(await handler(event({ command: "echo *" }), context({ hasUI: false })), undefined);
    assert.ok(await handler(event({ command: "echo danger" }), context({ hasUI: false })));
  });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).bash, ["git status", "echo *"]);
});

test("concurrent permanent approvals wait for the lock and retain both commands", async () => {
  const path = join(testDir, "concurrent.json");
  mkdirSync(`${path}.lock`);
  const handler = extension(async () => response({ destructive: 0.9 }), path);
  const release = setTimeout(() => rmdirSync(`${path}.lock`), 40);
  await withApiKey("test-key", async () => {
    const decisions = await Promise.all([
      handler(event({ command: "first" }), context({ choices: ["Always allow"] })),
      handler(event({ command: "second" }), context({ choices: ["Always allow"] })),
    ]);
    assert.deepEqual(decisions, [undefined, undefined]);
  });
  clearTimeout(release);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).bash.sort(), ["first", "second"]);
});


test("high risk blocks automatically when UI is unavailable; string redaction covers common tokens", async () => {
  const handler = extension(async () => response({ ask_first: 0.9 }));
  await withApiKey("test-key", async () => {
    assert.deepEqual(await handler(event(), context({ hasUI: false })), {
      block: true,
      reason: "Blocked: approval UI is unavailable.",
    });
  });
  assert.equal(
    redactSecrets("Authorization: Bearer abc.def and api_key=secret-value and OPENROUTER_API_KEY=opaque"),
    "[REDACTED] and [REDACTED] and [REDACTED]",
  );
});
