# Pi Jev Skill Selector

Pi extension that asks `typesafe/jev-1.13` through OpenRouter which skills are required for each user message, then exposes at most one primary and two supporting skills to the main agent.

## Install

```sh
pi install npm:pi-jev-skill-selector
```

For local development:

```sh
npm install
pi -e ./src/index.ts
```

## Configure

Set `OPENROUTER_API_KEY`. Optional variables:

- `PI_SKILL_SELECTOR_THRESHOLD` — probability in `[0, 1]` (default `0.60`)
- `PI_SKILL_SELECTOR_TIMEOUT_MS` — positive integer milliseconds (default `3000`)
- `PI_SKILL_SELECTOR_ALWAYS_VISIBLE` — comma-separated optional skills shown on every successful routing run (default `pi-subagents`); set to an empty string to disable
- `PI_SKILL_SELECTOR_ENABLED=0` — disable routing entirely; no requests are sent to OpenRouter, and Pi keeps its full skill list

If routing is unavailable, invalid, disabled, or the user attaches an image, the extension leaves Pi's complete skill list unchanged. Skills marked `disable-model-invocation` remain callable explicitly and are never routed automatically.

Privacy: a routing request sends the current user message, skill names and descriptions, and up to 2,000 characters of the previous user message on the active session branch to OpenRouter. Images are not sent. Set `PI_SKILL_SELECTOR_ENABLED=0` before working with confidential prompts if this transfer is not acceptable.

## Test

```sh
npm test
npm run typecheck
```
