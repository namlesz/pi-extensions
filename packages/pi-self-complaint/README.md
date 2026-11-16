# pi-self-complaint

A Pi extension that, after each agent run, asks the model whether anything about the system annoyed it. If it names a concrete problem, the sentence is appended to `docs/agent-complaints.md` in the project. Off by default.

Each enabled run makes one extra model request, so it costs tokens. Turn it on only where you want the feedback.

## Install

```sh
pi install npm:pi-self-complaint
```

For one invocation use `pi -e npm:pi-self-complaint`. Requires Pi `>=0.87.1`, which provides the `agent_before_settle` hook.

## Usage

```
/complaints on       # ask in this project
/complaints off      # stop asking in this project
/complaints          # show status for this project and the log path
```

The setting is per project directory. It is stored in `~/.pi/agent/self-complaint.json` (or `$PI_CODING_AGENT_DIR/self-complaint.json`) as a map from absolute directory path to `true`. Every new session in an enabled directory asks; other directories are unaffected. The match is exact: subdirectories and moved or renamed folders need `/complaints on` again.

## How it works

1. When a run completes, the extension adds a hidden question (`display: false`) and requests one more model response.
2. The model answers with exactly `NO` or `COMPLAINT: <one sentence>`.
3. A complaint is appended as a line to `docs/agent-complaints.md`, with the date, session ID, and project name:

```
# Agent complaints

- 2026-11-16 20:40 · session 01a1e0d4 · #my-project · pnpm gate keeps running after the rules step fails
```

Aborted and errored runs are not asked. Runs that only pause while background work is still going are not asked either: with `pi-background-tasks` a task that will wake the agent (`notifyOnCompletion` and `triggerOnCompletion`), and with `pi-subagents` an async subagent run, count as pending until their completion arrives. The question then comes in the run that the result starts. Without those extensions nothing is tracked and each run is asked as before. Replies that are neither `NO` nor a `COMPLAINT:` line are ignored and logged nothing. The question is asked once per run, so the extension cannot loop.

## Privacy

The sentence is written by the model and may contain paths, code fragments, or secrets from the session context. Everything stays local: nothing is sent anywhere except the normal model request Pi already makes. The log lives inside the project, so check `docs/agent-complaints.md` before committing it or add it to `.gitignore`.

## Limits

Answers are model self-reports: they can be invented to fit the question or missing when the model is unaware of a problem. Treat them as leads to verify, not as measurements.

## Development checks

```sh
npm test
npm run typecheck
```

Tests use a mocked Pi API and never call a model.
