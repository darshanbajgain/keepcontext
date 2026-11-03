// MCP server: the same context, exposed as tools to Claude, ChatGPT, Gemini, Antigravity, Cursor, Codex...
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import * as ctx from './context.js';
import { syncGithub } from './github.js';

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const kind = z.enum(ctx.KINDS);
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const includePrivate = z.boolean().optional()
  .describe('Also return entries marked private. Only honored on the bearer-token connection, never on the secret URL.');

/**
 * allowPrivate: true only for the Authorization header with the shared token or a connection allowed private access.
 * caller: who is calling (server.js resolveCaller); its slug is recorded on every change, so the hub knows the app
 * even when the model reports the wrong source.
 */
export function buildMcpServer({ allowPrivate = false, caller = null } = {}) {
  const priv = (asked) => allowPrivate && !!asked;
  const appSlug = caller?.slug || null;
  // Tasks: private ones (company repos) for callers allowed private context or that worked on them, never the secret URL.
  const viewer = { app: appSlug, includePrivate: allowPrivate, viaUrl: caller?.via === 'url' };
  const server = new McpServer(
    { name: 'keepcontext', version: config.version },
    {
      instructions:
        `Personal memory shared by all your AI apps${config.ownerName ? ` (${config.ownerName})` : ''}. Call get_context at the start of a conversation and follow its ` +
        'standing instructions. Save new ideas, decisions, todos and notes with save_entry (the hub records which app you are). ' +
        'Search before asking the user for background. For multi-step work use tasks (start_task, then checkpoint_task after ' +
        'each step) so another app can continue with resume_task if you stop; check list_open_tasks at the start.',
    },
  );

  server.registerTool('get_context', {
    title: 'KeepContext: Get context',
    description: 'KeepContext (personal shared memory): Load the shared context bundle: profile, standing instructions, pinned items, recent ideas/decisions/todos, projects and recent GitHub activity. Call this first.',
    inputSchema: {
      repo: z.string().optional().describe('Focus on one repo (adds its notes and filters activity).'),
      include_private: includePrivate,
    },
    annotations: RO,
  }, async ({ repo, include_private }) => text(ctx.contextBundle({ repo, includePrivate: priv(include_private), taskViewer: viewer })));

  server.registerTool('search_context', {
    title: 'KeepContext: Search context',
    description: 'KeepContext (personal shared memory): Full-text search over ideas, notes, instructions, decisions and todos.',
    inputSchema: {
      query: z.string().describe('Words to search for'),
      kind: kind.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      include_private: includePrivate,
    },
    annotations: RO,
  }, async ({ query, kind: k, limit, include_private }) =>
    text(ctx.listEntries({ q: query, kind: k, limit: limit || 20, includePrivate: priv(include_private) })));

  server.registerTool('list_entries', {
    title: 'KeepContext: List entries',
    description: 'KeepContext (personal shared memory): List entries filtered by kind, tag, repo or status, newest first.',
    inputSchema: {
      kind: kind.optional(), tag: z.string().optional(), repo: z.string().optional(),
      status: z.string().optional().describe('open | done | archived'), limit: z.number().int().min(1).max(200).optional(),
      include_private: includePrivate,
    },
    annotations: RO,
  }, async ({ include_private, ...a }) => text(ctx.listEntries({ ...a, includePrivate: priv(include_private) })));

  server.registerTool('save_entry', {
    title: 'KeepContext: Save idea / note / decision',
    description: 'KeepContext (personal shared memory): Save something every other agent should know: a new idea, a decision, a todo, a note, or a standing instruction.',
    inputSchema: {
      kind: kind.describe('idea | note | instruction | decision | todo | profile'),
      title: z.string().min(1).describe('One line'),
      body: z.string().optional().describe('Details, markdown ok'),
      tags: z.array(z.string()).optional(),
      repo: z.string().optional().describe('Repo this relates to, if any'),
      source: z.string().optional().describe('Optional: your app name. The hub already records the verified app from your connection.'),
      pinned: z.boolean().optional(),
      private: z.boolean().optional().describe('Hide from agents by default; still shown in the web UI.'),
    },
    annotations: RW,
  }, async (a) => text(ctx.createEntry({ ...a, source: a.source || appSlug, app: appSlug })));

  server.registerTool('update_entry', {
    title: 'KeepContext: Update entry',
    description: 'KeepContext (personal shared memory): Edit an entry by id: change text, tags, status (open/done/archived) or pin it.',
    inputSchema: {
      id: z.number().int(), title: z.string().optional(), body: z.string().optional(), kind: kind.optional(),
      tags: z.array(z.string()).optional(), repo: z.string().optional(), status: z.string().optional(), pinned: z.boolean().optional(),
      private: z.boolean().optional(),
    },
    annotations: RW,
  }, async ({ id, ...patch }) => text(ctx.updateEntry(id, patch, { includePrivate: allowPrivate, by: appSlug || 'agent' })));

  server.registerTool('list_projects', {
    title: 'KeepContext: List projects',
    description: 'KeepContext (personal shared memory): GitHub repos with visibility, last push date (local time), and your status / use-for notes.',
    inputSchema: {},
    annotations: RO,
  }, async () => text(ctx.projects()));

  server.registerTool('update_project', {
    title: 'KeepContext: Update project',
    description: 'KeepContext (personal shared memory): Set your own status or "use for" note on a repo.',
    inputSchema: { name: z.string(), status: z.string().optional(), use_for: z.string().optional() },
    annotations: RW,
  }, async ({ name, ...p }) => text(ctx.updateProject(name, p)));

  server.registerTool('get_activity', {
    title: 'KeepContext: Get repo activity',
    description: 'KeepContext (personal shared memory): Activity log rows (date in local time, repo, type, summary), newest first: one row per day per repo for commits, one per PR event.',
    inputSchema: { days: z.number().int().min(1).max(365).optional(), repo: z.string().optional() },
    annotations: RO,
  }, async ({ days, repo }) => text(ctx.activity({ days: days || 14, repo })));

  server.registerTool('sync_github', {
    title: 'KeepContext: Sync GitHub',
    description: 'KeepContext (personal shared memory): Pull new commits and pull requests from GitHub now (read-only on GitHub).',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async () => text(await syncGithub()));

  server.registerTool('get_unlogged_activity', {
    title: 'KeepContext: Activity not yet in the work log',
    description: 'KeepContext (personal shared memory): Activity rows not yet copied to your work log (a doc, CV notes or status report), plus a ready-to-paste markdown table (Date | Repo | Type | Summary, newest first). After writing them into the doc, call mark_activity_logged with their keys.',
    inputSchema: { days: z.number().int().min(1).max(365).optional() },
    annotations: RO,
  }, async ({ days }) => text(ctx.workLogRows({ days: days || 60 })));

  server.registerTool('mark_activity_logged', {
    title: 'KeepContext: Mark activity as logged',
    description: 'KeepContext (personal shared memory): Record that these activity rows are now in your work log so they are not offered again.',
    inputSchema: { keys: z.array(z.string()).min(1) },
    annotations: RW,
  }, async ({ keys }) => text({ marked: ctx.markLogged(keys) }));

  server.registerTool('get_repo_context_files', {
    title: 'KeepContext: Repo context files',
    description: 'KeepContext (personal shared memory): AGENTS.md, CLAUDE.md, GEMINI.md and .cursor/rules files that point any coding agent at this hub. Returns file contents; it does not write to any repo.',
    inputSchema: { repo: z.string().optional() },
    annotations: RO,
  }, async ({ repo }) => text(ctx.repoContextFiles({ repo })));

  /* ---------- continue-anywhere tasks (docs/HANDOFF_PLAN.md) ---------- */
  const list = (what) => z.array(z.string()).optional().describe(what);
  const taskId = z.number().int().describe('Task id (from start_task, list_open_tasks or get_context)');

  server.registerTool('start_task', {
    title: 'KeepContext: Start a task (handoff-ready)',
    description: 'KeepContext (personal shared memory): Start a multi-step task so any other AI app can continue it if you stop (usage limit, outage). Returns the task id and a git branch to work on. Then call checkpoint_task after each meaningful step.',
    inputSchema: {
      title: z.string().min(1).describe('Short name, e.g. "Audit log for requests"'),
      goal: z.string().optional().describe('What done looks like, in a sentence or two'),
      repo: z.string().optional().describe('Repo name (folder name), if it is coding work'),
      branch: z.string().optional().describe('Branch to work on (default: wip/<id>-<title>)'),
      next: list('The first steps you plan'),
      private: z.boolean().optional().describe('Hide from the secret URL and other apps without private access. Default: private for repos the hub does not sync (e.g. company repos).'),
    },
    annotations: RW,
  }, async (a) => text(ctx.startTask(a, viewer)));

  server.registerTool('checkpoint_task', {
    title: 'KeepContext: Checkpoint a task',
    description: 'KeepContext (personal shared memory): Record progress on a task after each meaningful step (a file changed, a decision, a test run). Keep it short. Your app can stop at any time, so the latest checkpoint is all the next app gets. Commit work in progress to the task branch first and pass the commit.',
    inputSchema: {
      task_id: taskId,
      summary: z.string().min(1).describe('What you just did, one or two sentences'),
      next: list('Exact next steps for whoever continues'),
      done: list('Steps finished since the last checkpoint'),
      files: list('Paths touched'),
      decisions: list('Decisions made'),
      questions: list('Open questions for the user'),
      commit: z.string().optional().describe('Latest commit sha on the branch'),
      branch: z.string().optional().describe('Only if you moved to another branch'),
      reason: z.enum(['step', 'limit-warning']).optional().describe('limit-warning: you are close to your usage limit'),
    },
    annotations: RW,
  }, async ({ task_id, ...cp }) => text(ctx.checkpointTask(task_id, cp, viewer)));

  server.registerTool('list_open_tasks', {
    title: 'KeepContext: List open tasks',
    description: 'KeepContext (personal shared memory): Tasks still in progress, newest first, with the app that worked on them last, when, and the next step. Check this at the start of a session to offer resuming.',
    inputSchema: {
      repo: z.string().optional().describe('Only tasks for this repo'),
      status: z.enum(['active', 'done', 'abandoned', 'all']).optional().describe('Default: active'),
    },
    annotations: RO,
  }, async ({ repo, status }) => text(ctx.listTasks({ repo, status: status || 'active' }, viewer)));

  server.registerTool('resume_task', {
    title: 'KeepContext: Resume a task',
    description: 'KeepContext (personal shared memory): Continue a task another app (or you, earlier) started: returns the goal, where it stopped, the next steps, the branch, the history, and what others did since your last checkpoint. Makes you the owner. Without task_id: the most recent open task (optionally for one repo). For a finished task it is a review only.',
    inputSchema: { task_id: taskId.optional(), repo: z.string().optional() },
    annotations: RW,
  }, async ({ task_id, repo }) => text(ctx.resumeTask({ id: task_id, repo }, viewer)));

  server.registerTool('finish_task', {
    title: 'KeepContext: Finish a task',
    description: 'KeepContext (personal shared memory): Mark a task done (or abandoned) with a short result.',
    inputSchema: {
      task_id: taskId,
      summary: z.string().min(1).describe('The result: what was built or decided, where it is (branch, PR)'),
      status: z.enum(['done', 'abandoned']).optional().describe('Default: done'),
    },
    annotations: RW,
  }, async ({ task_id, summary, status }) => text(ctx.finishTask(task_id, { summary, status: status || 'done' }, viewer)));

  return server;
}
