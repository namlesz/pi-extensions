import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import selfComplaint from "../src/index.ts";
import {
  LOG_RELATIVE_PATH,
  MAX_COMPLAINT_CHARS,
  QUESTION_TYPE,
  appendComplaint,
  formatEntry,
  lastAssistantText,
  parseAnswer,
  sanitize,
} from "../src/complaint.ts";
import { isEnabled, readStates, writeEnabled } from "../src/state.ts";
import { BACKGROUND_TERMINAL, SUBAGENT_ASYNC_COMPLETE, SUBAGENT_ASYNC_STARTED } from "../src/background.ts";

const testDir = mkdtempSync(join(tmpdir(), "self-complaint-"));
after(() => rmSync(testDir, { recursive: true, force: true }));

type Outcome = "completed" | "aborted" | "error";
type Handler = (event: any, ctx: ExtensionContext) => unknown;

/**
 * One Pi session in one project directory; `statePath` is shared across sessions to model persistence.
 * `events: false` models a Pi host without the shared `pi.events` bus.
 */
function harness(cwd: string, statePath: string, options: { events?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, ((payload: unknown) => void)[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notes: { message: string; level: string }[] = [];

  const events = {
    on: (name: string, handler: (payload: unknown) => void) => {
      busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
      return () => busHandlers.set(name, (busHandlers.get(name) ?? []).filter((other) => other !== handler));
    },
    emit: (name: string, payload: unknown) => {
      for (const handler of busHandlers.get(name) ?? []) handler(payload);
    },
  };

  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, command.handler);
    },
    ...(options.events === false ? {} : { events }),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "sess-1" },
    ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
  } as unknown as ExtensionContext;

  selfComplaint(pi, statePath);

  const emit = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const settle = (outcome: Outcome = "completed", assistantText?: string) =>
    emit("agent_before_settle", {
      type: "agent_before_settle",
      outcome,
      entries: [],
      continue: false,
      context: {
        contextEntries: [],
        contextMessages: assistantText === undefined ? [] : [
          { role: "user", content: [{ type: "text", text: "question" }] },
          { role: "assistant", content: [{ type: "text", text: assistantText }] },
        ],
        llmMessages: [],
        pendingMessages: [],
        canContinue: true,
      },
    });
  const command = (args: string) => commands.get("complaints")!(args, ctx);
  const publish = (name: string, payload: unknown) => events.emit(name, payload);

  return { emit, settle, command, notes, publish };
}

const bgTask = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "running",
  notifyOnCompletion: true,
  triggerOnCompletion: true,
  ...overrides,
});

test("parseAnswer accepts NO and COMPLAINT lines and rejects anything else", () => {
  assert.deepEqual(parseAnswer("NO"), { type: "none" });
  assert.deepEqual(parseAnswer("  no.  "), { type: "none" });
  assert.deepEqual(parseAnswer("COMPLAINT: the deploy task hides per-call logs"), {
    type: "complaint",
    text: "the deploy task hides per-call logs",
  });
  assert.deepEqual(parseAnswer("\n\ncomplaint:   spaced   out  \nignored second line"), {
    type: "complaint",
    text: "spaced out",
  });
  assert.deepEqual(parseAnswer("Sure, here is my answer: NO"), { type: "invalid" });
  assert.deepEqual(parseAnswer("COMPLAINT:    "), { type: "invalid" });
  assert.deepEqual(parseAnswer("   "), { type: "invalid" });
  assert.deepEqual(parseAnswer(""), { type: "invalid" });
});

test("sanitize collapses whitespace and caps length", () => {
  assert.equal(sanitize("a\n\tb   c"), "a b c");
  const long = sanitize("x".repeat(MAX_COMPLAINT_CHARS + 50));
  assert.equal(long.length, MAX_COMPLAINT_CHARS);
  assert.ok(long.endsWith("…"));
});

test("formatEntry matches the log line layout", () => {
  const line = formatEntry(new Date(2026, 10, 16, 20, 40), "sess-1", "project-a", "gate keeps running");
  assert.equal(line, "- 2026-11-16 20:40 · session sess-1 · #project-a · gate keeps running");
});

test("appendComplaint creates docs folder and heading once", () => {
  const path = join(testDir, "append", "docs", "agent-complaints.md");
  appendComplaint(path, "- first");
  appendComplaint(path, "- second");
  assert.equal(readFileSync(path, "utf8"), "# Agent complaints\n\n- first\n- second\n");
});

test("lastAssistantText returns the latest assistant text parts", () => {
  assert.equal(lastAssistantText([]), "");
  assert.equal(
    lastAssistantText([
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "NO" }] },
    ]),
    "NO",
  );
});

test("state file: missing is empty, enable and disable keep other projects", () => {
  const path = join(testDir, "state-1", "self-complaint.json");
  assert.deepEqual(readStates(path), {});
  writeEnabled(path, "/work/a", true);
  writeEnabled(path, "/work/b", true);
  writeEnabled(path, "/work/a", false);
  assert.deepEqual(readStates(path), { "/work/b": true });
  assert.equal(isEnabled(path, "/work/a"), false);
  assert.equal(isEnabled(path, "/work/b"), true);
});

test("state file: invalid content throws and is not overwritten", () => {
  const path = join(testDir, "state-2", "self-complaint.json");
  writeEnabled(path, "/work/a", true);
  writeFileSync(path, "[1, 2]");
  assert.throws(() => writeEnabled(path, "/work/b", true), /Invalid self-complaint state file/);
  assert.equal(readFileSync(path, "utf8"), "[1, 2]");
});

test("hook does nothing while the project is off (default)", async () => {
  const cwd = join(testDir, "default-off");
  const h = harness(cwd, join(testDir, "state-3", "self-complaint.json"));
  assert.equal(await h.settle("completed", "COMPLAINT: anything"), undefined);
  assert.equal(existsSync(join(cwd, LOG_RELATIVE_PATH)), false);
});

test("enabling one project does not enable another", async () => {
  const statePath = join(testDir, "state-4", "self-complaint.json");
  const a = harness(join(testDir, "project-a"), statePath);
  const b = harness(join(testDir, "project-b"), statePath);
  await a.command("on");
  assert.equal((await a.settle("completed") as { continue: boolean }).continue, true);
  assert.equal(await b.settle("completed"), undefined);
});

test("a run asks once, logs the complaint, then settles", async () => {
  const cwd = join(testDir, "project-c");
  const statePath = join(testDir, "state-5", "self-complaint.json");
  const h = harness(cwd, statePath);
  await h.command("on");

  const first = (await h.settle("completed")) as { continue: boolean; entries: { type: string; customType?: string; display?: boolean }[] };
  assert.equal(first.continue, true);
  const question = first.entries.at(-1)!;
  assert.equal(question.type, "custom_message");
  assert.equal(question.customType, QUESTION_TYPE);
  assert.equal(question.display, false);

  assert.equal(await h.settle("completed", "COMPLAINT: pnpm gate keeps running after the rules step fails"), undefined);
  const log = readFileSync(join(cwd, LOG_RELATIVE_PATH), "utf8");
  assert.match(log, /^# Agent complaints\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · session sess-1 · #project-c · pnpm gate keeps running after the rules step fails\n$/);
  assert.ok(h.notes.some((note) => note.message.includes("saved")));
});

test("NO answer and invalid answers write nothing and do not loop", async () => {
  const cwd = join(testDir, "project-d");
  const h = harness(cwd, join(testDir, "state-6", "self-complaint.json"));
  await h.command("on");

  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
  assert.equal(await h.settle("completed", "NO"), undefined);
  assert.equal(existsSync(join(cwd, LOG_RELATIVE_PATH)), false);

  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
  assert.equal(await h.settle("completed", "I think so, maybe"), undefined);
  assert.equal(existsSync(join(cwd, LOG_RELATIVE_PATH)), false);
});

test("aborted or errored runs are not asked and not continued", async () => {
  const h = harness(join(testDir, "project-e"), join(testDir, "state-7", "self-complaint.json"));
  await h.command("on");
  assert.equal(await h.settle("aborted"), undefined);
  assert.equal(await h.settle("error"), undefined);
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("agent_settled resets the pending question so the next run asks again", async () => {
  const h = harness(join(testDir, "project-f"), join(testDir, "state-8", "self-complaint.json"));
  await h.command("on");
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
  await h.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("off stops asking; the setting survives a new session in the same project", async () => {
  const cwd = join(testDir, "project-g");
  const statePath = join(testDir, "state-9", "self-complaint.json");
  const first = harness(cwd, statePath);
  await first.command("on");

  const second = harness(cwd, statePath);
  assert.equal((await second.settle("completed") as { continue: boolean }).continue, true);

  await second.command("off");
  const third = harness(cwd, statePath);
  assert.equal(await third.settle("completed", "COMPLAINT: ignored while off"), undefined);
});

test("status and invalid usage report without changing state", async () => {
  const statePath = join(testDir, "state-10", "self-complaint.json");
  const h = harness(join(testDir, "project-h"), statePath);
  await h.command("");
  assert.match(h.notes.at(-1)!.message, /Agent complaints for .*project-h: off/);
  await h.command("maybe");
  assert.equal(h.notes.at(-1)!.level, "warning");
  assert.equal(existsSync(statePath), false);
});

test("corrupt state: command reports an error and the hook stays silent", async () => {
  const statePath = join(testDir, "state-11", "self-complaint.json");
  mkdirSync(join(testDir, "state-11"), { recursive: true });
  writeFileSync(statePath, "not json");
  const cwd = join(testDir, "project-i");
  const h = harness(cwd, statePath);

  await h.command("on");
  assert.equal(h.notes.at(-1)!.level, "error");
  assert.equal(readFileSync(statePath, "utf8"), "not json");

  assert.equal(await h.settle("completed", "COMPLAINT: should not ask"), undefined);
  assert.equal(h.notes.at(-1)!.level, "error");
});

test("a background subagent run blocks the question until it completes", async () => {
  const cwd = join(testDir, "project-bg-1");
  const h = harness(cwd, join(testDir, "state-12", "self-complaint.json"));
  await h.command("on");

  h.publish(SUBAGENT_ASYNC_STARTED, { id: "run-1" });
  assert.equal(await h.settle("completed"), undefined);

  h.publish(SUBAGENT_ASYNC_COMPLETE, { id: "run-1" });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("a background shell task blocks the question until its terminal event", async () => {
  const h = harness(join(testDir, "project-bg-2"), join(testDir, "state-13", "self-complaint.json"));
  await h.command("on");

  await h.emit("tool_result", { type: "tool_result", toolName: "bg_run", details: { task: bgTask("task-1") } });
  assert.equal(await h.settle("completed"), undefined);

  h.publish(BACKGROUND_TERMINAL, { schema_version: 1, task: { id: "task-1", status: "completed" } });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("only the matching background task is released", async () => {
  const h = harness(join(testDir, "project-bg-3"), join(testDir, "state-14", "self-complaint.json"));
  await h.command("on");

  await h.emit("tool_result", { type: "tool_result", toolName: "bg_run", details: { task: bgTask("task-a") } });
  await h.emit("tool_result", { type: "tool_result", toolName: "bg_run", details: { task: bgTask("task-b") } });
  h.publish(BACKGROUND_TERMINAL, { schema_version: 1, task: { id: "task-a" } });
  assert.equal(await h.settle("completed"), undefined);

  h.publish(BACKGROUND_TERMINAL, { schema_version: 1, task: { id: "task-b" } });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("background tasks that do not wake the parent, or are not running, do not block", async () => {
  const h = harness(join(testDir, "project-bg-4"), join(testDir, "state-15", "self-complaint.json"));
  await h.command("on");

  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bg_run",
    details: { task: bgTask("quiet", { triggerOnCompletion: false }) },
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bg_status",
    details: { task: bgTask("done", { status: "completed" }) },
  });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});

test("the question is asked in the run that the background completion starts", async () => {
  const cwd = join(testDir, "project-bg-5");
  const h = harness(cwd, join(testDir, "state-16", "self-complaint.json"));
  await h.command("on");

  // Run 1: the parent launches work and ends its turn to wait. No question yet.
  await h.emit("tool_result", { type: "tool_result", toolName: "bg_run", details: { task: bgTask("task-1") } });
  assert.equal(await h.settle("completed"), undefined);

  // Run 2: the completion arrives and starts a new run. This is the one that asks.
  h.publish(BACKGROUND_TERMINAL, { schema_version: 1, task: { id: "task-1", status: "completed" } });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
  assert.equal(await h.settle("completed", "COMPLAINT: the wait had no progress output"), undefined);
  assert.match(readFileSync(join(cwd, LOG_RELATIVE_PATH), "utf8"), /the wait had no progress output/);
});

test("without the pi.events bus the question is asked at every settle, as before", async () => {
  const h = harness(join(testDir, "project-bg-6"), join(testDir, "state-17", "self-complaint.json"), { events: false });
  await h.command("on");

  await h.emit("tool_result", { type: "tool_result", toolName: "bg_run", details: { task: bgTask("task-1") } });
  assert.equal((await h.settle("completed") as { continue: boolean }).continue, true);
});
