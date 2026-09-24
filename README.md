# Pi extensions

Independent Pi packages in one npm workspace. Each directory under `packages/` has its own `package.json`, `pi.extensions` entry and version, so it can be published and installed separately.

| Package | Description |
| --- | --- |
| [`pi-jev-skill-selector`](packages/pi-jev-skill-selector/) | Route skills with Jev via OpenRouter |
| [`pi-jev-guard`](packages/pi-jev-guard/) | Guard shell commands with Jev and manual approval |

```sh
npm install
npm test
npm run typecheck
```

To add an extension, create `packages/<package-name>/` with its own `package.json` and `pi.extensions` pointing to its entry file. npm will discover it through `workspaces` automatically.

Preview a package with `npm pack --dry-run --workspace pi-jev-guard` (or `pi-jev-skill-selector`). Publish each separately with `npm publish --workspace <package-name>` only when ready. After publishing, install one with `pi install npm:<package-name>`.
