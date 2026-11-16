import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const QUESTION_TYPE = "self-complaint-question";
export const LOG_RELATIVE_PATH = "docs/agent-complaints.md";
export const MAX_COMPLAINT_CHARS = 500;

export const QUESTION = [
  "Before you finish: did anything about the system, its tools, or this workflow annoy you during this run?",
  "Reply with exactly one line and nothing else:",
  "NO",
  "or",
  "COMPLAINT: <one concrete sentence naming the specific tool, step, or behaviour>",
].join("\n");

export type ParsedAnswer =
  | { type: "complaint"; text: string }
  | { type: "none" }
  | { type: "invalid" };

/** Reads the first non-empty line of the reply. Anything else is treated as invalid and logs nothing. */
export function parseAnswer(text: string): ParsedAnswer {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "");
  if (line === undefined) return { type: "invalid" };
  if (/^NO\.?$/i.test(line)) return { type: "none" };
  const match = /^COMPLAINT:\s*(.+)$/i.exec(line);
  const complaint = match?.[1] ? sanitize(match[1]) : "";
  return complaint ? { type: "complaint", text: complaint } : { type: "invalid" };
}

/** Collapses whitespace and caps length so one complaint stays one line in the log. */
export function sanitize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_COMPLAINT_CHARS ? `${oneLine.slice(0, MAX_COMPLAINT_CHARS - 1)}…` : oneLine;
}

export function formatEntry(when: Date, sessionId: string, project: string, complaint: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `- ${stamp} · session ${sessionId} · #${project} · ${complaint}`;
}

/** Appends one line, creating the file with a heading the first time. */
export function appendComplaint(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = existsSync(path) ? "" : "# Agent complaints\n\n";
  appendFileSync(path, `${header}${line}\n`, "utf8");
}

/** Returns the text of the most recent assistant message, or "" when there is none. */
export function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}
