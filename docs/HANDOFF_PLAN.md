# Continue anywhere: handoffs between AI apps

**Problem.** You're halfway through a task in one app (Claude Code, Cursor, Codex, Antigravity, ChatGPT…) and it hits its usage limit. Today the work, the plan and the reasoning are stuck in that app until the limit resets. You want another app that still has quota to **continue from exactly where the first stopped**, and later to **review in the original app** what the others did.

**Idea.** The hub already gives every app the same memory. Add **tasks with checkpoints**: every app writes a short checkpoint after each meaningful step, so when one stops, any other can resume from the latest checkpoint and the code in git.

Status: **built 2026-11-03** (phase 1 plus most of phases 2 and 3; how it works: `docs/ARCHITECTURE.md` §5.6). Still open: the MCP `resume` prompt, GitHub compare links per checkpoint, public tasks in the Google Doc. Depends on per-app connections (v1.1.0), which give every checkpoint a verified app.

## 1. Key constraint: save before you need it

An app that has hit its limit can't do anything, including saving its state. So handoffs can't rely on a "save on exit". Instead:

- **Checkpoint continuously:** after each meaningful step (a file changed, a decision made, a test run), the agent calls `checkpoint_task` with a few lines. Cheap: a small MCP call.
- **Code state lives in git:** the task has a branch (`wip/<task-id>-<slug>`). Agents commit work in progress with `WIP: <task> step n`, so the next app gets the exact code by checking out the branch. The hub stores the branch and last commit, never the code itself.

## 2. Data model

| Table | Fields |
| --- | --- |
| `tasks` | `id`, `title`, `goal`, `repo`, `branch`, `status` (active / paused / done / abandoned), `private` (default **on** for company repos), `created_by` (connection), `owner` (connection currently working on it), `created_at`, `updated_at` |
| `task_checkpoints` | `id`, `task_id`, `app` (verified connection), `at`, `summary`, `done` (list), `next` (list: the exact next steps), `files` (paths touched), `decisions`, `open_questions`, `commit` (sha), `branch`, `reason` (step / limit-warning / handoff / finished) |

Checkpoints are append-only, so the whole history is a timeline.

## 3. MCP tools (and REST mirrors for the UI)

| Tool | What it does |
| --- | --- |
| `start_task` | Create a task (title, goal, repo, branch); returns `task_id`. Agents call it when you start non-trivial work |
| `checkpoint_task` | Append a checkpoint (summary, done, next, files, commit, reason) |
| `list_open_tasks` | Active and paused tasks, newest first, with the last checkpoint's app and time |
| `resume_task` | Full brief for the next app: goal, history, latest `next` steps, branch and commit, plus exact commands (`git fetch && git switch <branch>`), and what the previous app was about to do |
| `finish_task` | Mark done with a final summary (feeds the activity log) |
| MCP prompt `resume` | One-click "resume my last task" in clients that support prompts (TODO 3.4) |

## 4. How agents are told to do it

- **Repo context files** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor rule, written by `npm run inject`) gain a short section: *"At the start, call `list_open_tasks` for this repo and offer to resume. For multi-step work, `start_task`, then `checkpoint_task` after each step and commit WIP to the task branch."*
- A **standing instruction** in the hub says the same for chat apps.
- Agents that support it can checkpoint on a **"limit warning"** (some apps warn before the limit), with `reason: limit-warning`.

## 5. A typical day

1. In Claude Code: "build an audit log for the notes app". Claude calls `start_task` → branch `wip/31-audit-log`, then checkpoints after the migration, the model and the first test.
2. Claude Code hits its limit mid-route. The last checkpoint says: *next: add PATCH /notes/:id/tags route, write the Supertest test*.
3. You open Codex: "resume my task". Codex calls `resume_task`, checks out the branch, continues, and checkpoints as `Codex`.
4. Cursor finishes the UI part and calls `finish_task`.
5. Next day Claude Code's limit resets: "review task 31". It gets the timeline (Claude Code → Codex → Cursor) and runs `git diff <its last commit>..HEAD` to review what the others changed.

## 6. Dashboard

- **Tasks** tab: active tasks first; each shows a timeline of checkpoints with **app badges** (verified connection), time, summary, next steps, and a link to the commit or compare view.
- **Overview**: "Active tasks" card with the current owner app and how long since the last checkpoint.
- **Activity log**: one `Task` row per task per day (e.g. "Audit log: Claude Code → Codex, 6 checkpoints").

## 7. Privacy and safety

- Tasks for company repos are **private by default**: no Google Doc mirror, no secret-URL apps, and only connections with private access can resume them.
- Checkpoints hold summaries and file paths, never code, secrets or env values (the same rules as `AGENTS.md`).
- A task's branch is never pushed by the hub (GitHub stays read-only); agents commit in your local clone.

## 8. Phases

1. **MVP:** tables, the five tools, `AGENTS.md`/context-file instructions, a simple Tasks list in the UI. Tests with two fake connections handing off.
2. **Review:** timeline view, compare links (GitHub compare URL per checkpoint), "review since my last checkpoint" in `resume_task`.
3. **Polish:** MCP prompt/resource (`resume`), limit-warning checkpoints where clients expose it, Task rows in the activity log, Google Doc section for public tasks.

## 9. Risks

- **Agents forget to checkpoint.** Mitigate with clear instructions in repo files, a short tool description that says "call after each step", and a dashboard warning when an active task hasn't had a checkpoint for a while.
- **Two apps working on the same task at once.** `owner` plus a soft lock: `resume_task` warns if another connection checkpointed in the last 10 minutes.
- **Too much detail.** Keep checkpoints short (summary + next steps); the code history is in git.

## 10. Why it matters

This is the feature no single AI app can offer: **your work survives any one app's limits, outages or price changes.**
