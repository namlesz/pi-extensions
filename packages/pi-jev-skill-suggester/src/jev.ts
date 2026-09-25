export const JEV_MODEL = "typesafe/jev-1.13";
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export interface JevQuestion {
  type: "noul";
  instructions: string;
  criteria: { false: string; true: string };
}

export type JevQuestions = Record<string, JevQuestion>;

export interface JevAnswer {
  type: "noul";
  noul: number;
}

export type JevAnswers = Record<string, JevAnswer>;

export async function askJev(
  apiKey: string,
  state: string | { previousUserMessage: string; currentUserMessage: string },
  questions: JevQuestions,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<JevAnswers> {
  const controller = new AbortController();
  signal?.throwIfAborted();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Jev request timed out")), timeoutMs);

  try {
    const response = await fetcher(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, questions, state }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter returned HTTP ${response.status}`);

    const data: unknown = await response.json();
    return validateAnswers(data, Object.keys(questions));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function validateAnswers(data: unknown, questionIds: string[]): JevAnswers {
  if (!isRecord(data) || !isRecord(data.answers)) throw new Error("Invalid Decisions response");
  const answerIds = Object.keys(data.answers);
  if (answerIds.length !== questionIds.length || answerIds.some((id) => !questionIds.includes(id))) {
    throw new Error("Incomplete or unknown Decisions answers");
  }

  const answers: JevAnswers = {};
  for (const id of questionIds) {
    const answer = data.answers[id];
    if (
      !isRecord(answer) ||
      answer.type !== "noul" ||
      typeof answer.noul !== "number" ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new Error(`Invalid Decisions answer for ${id}`);
    }
    answers[id] = { type: "noul", noul: answer.noul };
  }
  return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
