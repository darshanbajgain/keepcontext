# Changelog

All notable changes to KeepContext. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/): **MAJOR** for breaking changes (API, MCP tools, data), **MINOR** for new features, **PATCH** for fixes. How to cut a release: [CONTRIBUTING.md](CONTRIBUTING.md).

## [Unreleased]

First public version.

### Added

- **One memory for every AI app** over MCP: ideas, notes, decisions, todos, standing instructions and profile facts, with search, tags, pins and private entries.
- **Connections:** one token per app and account, verified attribution (which app created or changed what), rotate and revoke per app, scoped access.
- **Continue anywhere:** tasks with checkpoints, so when one app hits its usage limit another resumes from the last checkpoint and the task's git branch; the first app can review what the others did.
- **GitHub activity** (read-only, optional): repos, commits and pull requests in an activity log, with a work log export.
- **Web UI:** Overview, Context, Tasks, Activity log, Projects, Apps and Repo files tabs; light and dark; mobile.
- **Google Doc mirror** (optional) of your public context for Drive-connected apps.
- **Security:** hashed connection tokens, private entries never over the secret URL, rate limits, read-only GitHub.
- Backup and restore scripts, end-to-end tests against a fake GitHub and a fake Google.
