# Pi extensions

Independent Pi packages in one npm workspace. Each directory under `packages/` has its own `package.json`, `pi.extensions` entry and version, so it can be published and installed separately.

| Package | Description |
| --- | --- |
| [`pi-jev-guardian`](packages/pi-jev-guard/) | Guard shell commands with Jev and manual approval |
| [`pi-self-complaint`](packages/pi-self-complaint/) | Ask the agent after each run what annoyed it; log concrete complaints to `docs/agent-complaints.md` (off by default) |

```sh
npm install
npm test
npm run typecheck
```

To add an extension, create `packages/<package-name>/` with its own `package.json` and `pi.extensions` pointing to its entry file. npm will discover it through `workspaces` automatically.

Preview a package with `npm pack --dry-run --workspace pi-jev-guardian` (or `pi-self-complaint`). Publish each separately with `npm publish --workspace <package-name>` only when ready. After publishing, install one with `pi install npm:<package-name>`.
