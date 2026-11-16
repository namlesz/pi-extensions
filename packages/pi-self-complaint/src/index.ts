import { basename, join } from "node:path";
import type { AgentBeforeSettleEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LOG_RELATIVE_PATH,
  QUESTION,
  QUESTION_TYPE,
  appendComplaint,
  formatEntry,
  lastAssistantText,
  parseAnswer,
} from "./complaint.ts";
import {
  BACKGROUND_TERMINAL,
  SUBAGENT_ASYNC_COMPLETE,
  SUBAGENT_ASYNC_STARTED,
  startedBackgroundTaskId,
  subagentRunId,
  terminalTaskId,
} from "./background.ts";
import { defaultStatePath, isEnabled, writeEnabled } from "./state.ts";

export default function selfComplaint(pi: ExtensionAPI, statePath = defaultStatePath()): void {
  // True while the one extra "did anything annoy you?" request of the current run is pending.
  let asked = false;

  // Background runs that will start a new run when they finish. The parent settles while they are still working,
  // so asking then would ask before the work is done. Ids are removed when the matching completion arrives.
  const pendingBackground = new Set<string>();
  const busUnsubscribes = [
    pi.events?.on(SUBAGENT_ASYNC_STARTED, (payload) => {
      const id = subagentRunId(payload);
      if (id) pendingBackground.add(id);
    }),
    pi.events?.on(SUBAGENT_ASYNC_COMPLETE, (payload) => {
      const id = subagentRunId(payload);
      if (id) pendingBackground.delete(id);
    }),
    pi.events?.on(BACKGROUND_TERMINAL, (payload) => {
      const id = terminalTaskId(payload);
      if (id) pendingBackground.delete(id);
    }),
  ];

  pi.on("session_start", () => {
    asked = false;
  });
  pi.on("session_tree", () => {
    asked = false;
  });
  pi.on("session_shutdown", () => {
    for (const unsubscribe of busUnsubscribes) unsubscribe?.();
    pendingBackground.clear();
  });

  // Tools that start a background shell or agent task return its snapshot in details.task. Without the bus there is
  // no completion event to remove the id again, so nothing is tracked.
  if (pi.events) {
    pi.on("tool_result", (event) => {
      const id = startedBackgroundTaskId(event.details);
      if (id) pendingBackground.add(id);
    });
  }

  pi.registerCommand("complaints", {
    description: "Turn agent self-complaints on, off, or show status for this project (on | off | status)",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase() || "status";
      if (value !== "on" && value !== "off" && value !== "status") {
        ctx.ui.notify("Usage: /complaints [on | off | status]", "warning");
        return;
      }
      try {
        if (value !== "status") writeEnabled(statePath, ctx.cwd, value === "on");
        const enabled = isEnabled(statePath, ctx.cwd);
        ctx.ui.notify(`Agent complaints for ${ctx.cwd}: ${enabled ? "on" : "off"} (log: ${LOG_RELATIVE_PATH})`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not update agent complaints: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("agent_before_settle", (event, ctx): AgentBeforeSettleEventResult | undefined => {
    if (event.outcome !== "completed") {
      asked = false;
      return;
    }
    if (!asked) {
      // Disabled projects, and unreadable state, never trigger the extra request.
      let enabled = false;
      try {
        enabled = isEnabled(statePath, ctx.cwd);
      } catch (error) {
        ctx.ui.notify(`Agent complaints disabled: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      if (!enabled) return;

      // Background work is still running, so this settle is only a pause. Its completion starts a new run, and
      // the question is asked there, once the work is actually done.
      if (pendingBackground.size > 0) return;

      // First boundary of the run: ask once and request exactly one more model response.
      asked = true;
      return {
        entries: [
          ...event.entries,
          { type: "custom_message", customType: QUESTION_TYPE, content: QUESTION, display: false },
        ],
        continue: true,
      };
    }

    // Second boundary: the continuation has run, so the answer is the last assistant message.
    asked = false;
    const answer = parseAnswer(lastAssistantText(event.context.contextMessages));
    if (answer.type !== "complaint") return;

    try {
      const path = join(ctx.cwd, LOG_RELATIVE_PATH);
      const line = formatEntry(new Date(), ctx.sessionManager.getSessionId(), basename(ctx.cwd), answer.text);
      appendComplaint(path, line);
      ctx.ui.notify(`Agent complaint saved to ${LOG_RELATIVE_PATH}`, "info");
    } catch (error) {
      // Never fail the run because the log could not be written.
      ctx.ui.notify(`Could not save agent complaint: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    return;
  });

  pi.on("agent_settled", () => {
    asked = false;
  });
}
