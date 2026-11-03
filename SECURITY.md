# Security policy

KeepContext holds personal context, private entries and app tokens, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer within a week. Once it's fixed and released, you're credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes. Update with `docker compose pull && docker compose up -d` (or `bash scripts/deploy.sh`).

## In scope

- Getting data, private entries or tasks without the right token or password
- Bypassing the setup code, rate limits or connection scopes
- Tokens, passwords or private data showing up in responses, logs, the Google Doc mirror or exports
- Injection into the UI (user data is supposed to be escaped everywhere)

## Out of scope

- A leaked secret URL or token used as intended (rotate the connection in the Apps tab)
- What an AI app does with context you gave it
- Instances exposed without HTTPS, or with a weak password

The security model is described in [docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-security-model).
