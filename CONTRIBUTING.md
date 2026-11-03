# Contributing to KeepContext

Thanks for helping! Bug reports, docs fixes, new app guides and features are all welcome.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected, and your setup (Docker or Node, which AI app). Never paste tokens, secret URLs or private entries.
- **Features:** open an issue first for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
- **Security problems:** don't open an issue; follow [SECURITY.md](SECURITY.md).

## Develop

You need Node 22.13 or newer. There is no build step.

```bash
npm install
npm test            # end-to-end tests against a fake GitHub and a fake Google
npm run dev         # restarts on changes; open http://localhost:8787 (setup code in the terminal)
DEMO=1 npm run dev  # or start with fictional data
```

Use a throwaway `DATA_DIR` while developing, never your real `hub.db`. `npm run mock:github` starts a fake GitHub on :9911 (`GITHUB_API_URL=http://localhost:9911`, `GITHUB_TOKEN=ghtest`). In VS Code, `.vscode/launch.json` has both set up.

How the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version, and the rules every change follows: [CLAUDE.md](CLAUDE.md) (written for coding agents, useful for humans too).

## Pull requests

- One topic per pull request, on a branch.
- `npm test` passes. New behaviour comes with a test in `test/hub.test.mjs`.
- The UI loads without console errors (check by hand: there are no browser tests yet).
- Plain ESM JavaScript, Node built-ins first, no new heavy dependencies, no build step.
- Business logic goes in `src/context.js` (or `src/settings.js` for settings); `server.js` and `mcp.js` stay thin wrappers, so the UI, REST and MCP behave the same.
- Escape user data in the UI with `esc()`. Never log or return secrets.
- User-visible changes add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Changes to behaviour, schema, routes, MCP tools, config or security update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Releases (maintainers)

Versions follow [Semantic Versioning](https://semver.org): MAJOR for breaking changes (API, MCP tools, data), MINOR for features, PATCH for fixes.

```bash
npm version minor --no-git-tag-version   # or patch / major
# CHANGELOG.md: rename "## [Unreleased]" to "## [x.y.z] - YYYY-MM-DD", add a new empty "## [Unreleased]" above it
git commit -am "Release vx.y.z" && git push
git tag vx.y.z && git push origin vx.y.z
```

The tag runs `release.yml` (tests, the tag must match `package.json`, a GitHub Release with that version's changelog section) and `docker.yml` (the multi-arch image on ghcr.io as `x.y.z`, `x.y` and `latest`).
