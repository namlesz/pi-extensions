/**
 * Event names published by the background-work extensions. They are plain strings on the shared `pi.events` bus,
 * so this package does not depend on them. Without those extensions nothing is ever published and nothing is tracked.
 */
export const SUBAGENT_ASYNC_STARTED = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE = "subagent:async-complete";
export const BACKGROUND_TERMINAL = "pi-background-tasks:terminal:v1";

function idOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Id of a background subagent run, from `subagent:async-started` or `subagent:async-complete`. */
export function subagentRunId(payload: unknown): string | undefined {
  return idOf(payload);
}

/** Id of a finished background shell or agent task, from `pi-background-tasks:terminal:v1`. */
export function terminalTaskId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return idOf((payload as { task?: unknown }).task);
}

/**
 * Id of a background task that was just started by a tool, from the tool result details (`details.task`).
 * Only tasks that wake the parent when they finish count: without notify and trigger the parent never
 * gets a new run for them, so waiting for them would silence complaints for good.
 */
export function startedBackgroundTaskId(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const task = (details as { task?: unknown }).task;
  if (!task || typeof task !== "object") return undefined;
  const { status, notifyOnCompletion, triggerOnCompletion } = task as Record<string, unknown>;
  if (status !== "running" || notifyOnCompletion !== true || triggerOnCompletion !== true) return undefined;
  return idOf(task);
}
