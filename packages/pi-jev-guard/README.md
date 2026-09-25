# pi-jev-guardian

A Pi extension that evaluates agent `bash` and `powershell` commands with OpenRouter Decisions using `typesafe/jev-1.13`. Other tools (including custom/extension tools) are not checked or blocked by this extension. Commands launched internally by another tool or extension are not visible to this guard.

It checks whether a command is **off-task**, **destructive or hard to reverse**, involves **untrusted input/code**, or needs the user to **approve an external side effect**. Each Noul score is validated as a finite number from 0 to 1. If any score meets the threshold, the user gets **Block** (first/default choice), **Allow once**, or **Always allow**.

An **Always allow** choice saves the exact command and shell globally to `~/.pi/agent/jev-guard-allow.json`. You can also edit that JSON file directly, for example:

```json
{
  "bash": ["pwd", "git status --short"],
  "powershell": [],
  "bashPatterns": ["npm *"],
  "powershellPatterns": []
}
```

`bash` and `powershell` contain exact, case-sensitive **whole commands**, including any shell syntax; `*` is literal there, including when saved via **Always allow**. For commands not approved exactly, the guard recognizes only plain-word commands joined by `;`, `&&`, `||`, or newlines. Every part must match an exact entry or a pattern for that shell. In manually edited `bashPatterns` and `powershellPatterns`, `*` matches characters within one such part, never a separator: `npm *` allows `npm test` and, with a separate approval for `git status`, `npm test && git status`, but not `npm test; rm -rf x`. Shell features outside this restricted syntax (quotes, substitutions, pipes, redirections, variables, escapes, etc.) are sent **as one whole command** to JEV or manual approval. This is not a full shell parser; patterns such as `npm *` still grant broad approval to individual commands (including `npm exec ...`). Approved commands skip JEV and the approval dialog even without an API key or UI. Protect this file: entries grant permanent approval in every project, and command text (including embedded secrets) is stored unredacted. No approval is cached for **Allow once**.

Concurrent **Always allow** writes use a temporary `.lock` directory next to the JSON file. If Pi crashes during a write, remove that stale directory manually before saving another approval.

When the API key is missing, the request fails or times out, or the response is invalid, the extension offers a manual choice. If the allowlist cannot be read or parsed, only **Block** and **Allow once** are offered; the file is not overwritten. Without UI, or if the user cancels, the command is blocked. Successful checks below threshold proceed without a dialog.

## Install

Install the published package from npm for your user:

```sh
pi install npm:pi-jev-guardian
```

For one invocation use `pi -e npm:pi-jev-guardian`; for a trusted project only, use `pi install --local npm:pi-jev-guardian`. These commands install the currently published version, which may differ from this checkout. Pi loads this package alongside other configured extensions and skills; review its source before installing it.

Pi loads TypeScript extensions directly; no build step is needed.

## Configuration

Set the OpenRouter key in the environment before starting Pi:

```sh
export OPENROUTER_API_KEY="..."
```

| Variable | Default | Accepted range | Meaning |
|---|---:|---:|---|
| `PI_JEV_GUARD_THRESHOLD` | `0.5` | `0`–`1` | Scores at or above this value require a user choice. |
| `PI_JEV_GUARD_TIMEOUT_MS` | `3000` | `100`–`15000` | Maximum JEV request duration in milliseconds. |

Invalid settings use the defaults. A missing key does not disable the guard; it switches to manual approval.

## Privacy

For each checked command, the extension sends the latest user text found in the active session, the shell tool name, and its arguments to `https://openrouter.ai/api/alpha/decisions`. Allowlisted commands and other tools send nothing. It sends the API key only in the HTTP `Authorization` header. Likely secrets are redacted from sensitive argument fields and recognizable text patterns before the request. The serialized state string is limited to 20,000 characters; oversized context falls back to manual approval without being sent.

Redaction is heuristic and cannot guarantee detection of every secret. Data that is not recognized as sensitive may be sent to OpenRouter. Do not use this extension if sending the task and tool-call context to OpenRouter is not acceptable. JEV is a risk signal, not a security boundary; review flagged actions before choosing **Allow once**.

## Development checks

```sh
npm test
npm run typecheck
```

Tests mock the Decisions endpoint; they never make a live request.
