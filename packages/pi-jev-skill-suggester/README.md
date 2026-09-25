# Pi Jev Skill Suggester

For each text user message, `typesafe/jev-1.13` scores whether each model-invocable skill could offer a specific benefit. Up to three suggestions above the threshold become an optional hint to the agent; Pi's full skill list remains available, and the agent decides which skills to read. Suggestions are made only at the start of a message, not again as the task evolves.

## Install

```sh
pi install npm:pi-jev-skill-suggester
```

For local development:

```sh
npm install
pi -e ./src/index.ts
```

## Configure

Set `OPENROUTER_API_KEY`. Optional variables:

- `PI_SELECTOR_THRESHOLD` — minimum Jev score in `[0, 1]` for a suggestion (default `0.70`). The older `PI_SKILL_SELECTOR_THRESHOLD` is still supported as a fallback.
- `PI_SKILL_SELECTOR_TIMEOUT_MS` — positive integer milliseconds (default `3000`)
- `PI_SKILL_SELECTOR_ENABLED=0` — disable suggestions entirely; no requests are sent to OpenRouter


In Pi, use `/skill-threshold 70` to set the minimum score as a percentage (0–100), or `/skill-limit 3` to set the maximum number of suggestions (non-negative integer; `0` skips Jev requests). Run either command without arguments to see its current value, or use `reset` to remove its saved override. Both commands persist across restarts in files under the Pi agent directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`). A saved threshold takes precedence over the environment variable; after reset, the variable (or the 70% default) applies. The default suggestion limit is 3.
All Pi skills stay visible regardless of Jev's answer. Skills marked `disable-model-invocation` are not sent to Jev or suggested automatically; Pi still permits explicit skill commands. With no eligible skills, a low score, an unavailable/invalid Jev response, a disabled extension, or an attached image, no hint is added. Jev scores are logged but do not prove a suggestion will help.

Privacy: a Jev request sends the current user message, eligible skill names and descriptions, and up to 2,000 characters of the previous user message on the active session branch to OpenRouter. Images are not sent. Set `PI_SKILL_SELECTOR_ENABLED=0` before working with confidential prompts if this transfer is not acceptable.

## Test

```sh
npm test
npm run typecheck
```
