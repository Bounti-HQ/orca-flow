// Preview-only: the account-switching UX drawn by the released Orca Flow 0.2.98 panel (read only)
// with synthetic data and a stub `orca`. Nothing here is shipped: src/ is untouched, and the
// proposal is a small preview script that adds to what the released renderer drew.
//   node scripts/account-failover-preview.mjs                         write docs/account-failover-preview/panel.html
// States (URL): healthy, included, switched, spent, notproof (&reason=), scope, settings (&page=accounts|models); &trigger=error, &host=today, &provider=codex.
//   node scripts/account-failover-preview.mjs --shots <dir> [--reference <png>]
//                                                                     also capture every state and run the checks
// ORCA_FLOW_RELEASE overrides where the released 0.2.98 source is read from.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const RELEASE = process.env.ORCA_FLOW_RELEASE ||
  join(homedir(), 'Library/Application Support/orca/plugins/bounti-hq.flow/9fca522a4b2153137b3ecc6342d8710708ed2d94d11543aefc8d6aed0ccaabdc')
const manifest = JSON.parse(readFileSync(join(RELEASE, 'orca-plugin.json'), 'utf8'))
if (manifest.version !== '0.2.98') throw new Error(`Expected the released Orca Flow 0.2.98 at ${RELEASE}, found ${manifest.version}`)

// ---- Build the released panel, unmodified, into a temp dir (the release folder is only read).
const build = mkdtempSync(join(tmpdir(), 'orca-flow-account-preview-'))
// A copy of the released src, so the bundle's path comments name src/... and never a local home folder.
cpSync(join(RELEASE, 'src'), join(build, 'src'), { recursive: true })
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', '--log-level=warning', `--outfile=${join(build, 'app.js')}`], { cwd: build, stdio: 'inherit' })
const appJs = readFileSync(join(build, 'app.js'), 'utf8')
rmSync(build, { recursive: true, force: true })
const css = readFileSync(join(RELEASE, 'src/panel/panel.css'), 'utf8')
const indexHtml = readFileSync(join(RELEASE, 'src/panel/index.html'), 'utf8')
const { speedView, emptyHistory, addResponse } = await import(pathToFileURL(join(RELEASE, 'src/token-speed.ts')).href)

// ---- Synthetic fixture, shaped like the live sidebar (density, tree, sections) with made-up names.
const T = Date.UTC(2026, 10, 24, 13, 30), MIN = 60_000, H = 60 * MIN
const agent = (paneKey, agentType, title, over = {}) => ({ paneKey, agentType, title, live: true, state: 'done', workingMode: null, coordinator: 'atlas',
  leadPane: null, parentPane: null, orcaSession: `session-${paneKey}`, dispatch: 'open', terminal: `term_${paneKey}`, question: null, summary: null,
  model: { name: agentType === 'claude' ? 'Opus 5.5' : 'GPT-6.2-Astra', source: 'seen' }, ...over })
const row = (id, a, over = {}) => ({ id, name: a.title, branch: 'feature', repo: 'mono', path: `/fixture/${id}`, main: false, agents: [a], state: a.state,
  priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: T - 6 * MIN, createdAt: 1, pr: null, ...over })
const home = (key, a, minutes) => row(`folder:${key}`, a, { name: key, repo: key, folderOf: key, branch: null, main: true, lastActivityAt: T - minutes * MIN })

const done = (role) => ({ role, title: 'Done', glance: '', goal: '', since: '', needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2' })
// atlas: a coordinator over all projects with four leads, one with two workers.
const atlasMain = agent('atlas-main', 'codex', 'Atlas coordination', { dispatch: null })
const intake = agent('intake', 'codex', 'Harbor rota import feedback', { parentPane: 'atlas-main' })
const courts = agent('courts', 'codex', 'Courtside booking blocker', { parentPane: 'atlas-main' })
const onboarding = agent('onboarding', 'claude', 'Onboarding form validation', { parentPane: 'atlas-main', state: 'working' })
const webfix = agent('webfix', 'codex', 'PR 4180 web fixes', { parentPane: 'onboarding', leadPane: 'onboarding', summary: done('worker'), dispatch: 'settled' })
const deeplink = agent('deeplink', 'codex', 'Android deep-link fix', { parentPane: 'onboarding', leadPane: 'onboarding', summary: done('worker'), dispatch: 'settled' })
const hours = agent('hours', 'codex', 'Weekly hours target', { parentPane: 'atlas-main', state: 'working' })
// flow-lab: one project, one lead. harbor: asleep.
const labMain = agent('lab-main', 'codex', 'Flow lab coordination', { coordinator: 'flow-lab', dispatch: null })
const usage = agent('usage', 'codex', 'Usage report export', { coordinator: 'flow-lab', parentPane: 'lab-main', state: 'working' })

const rows = [
  home('atlas', intake, 5 * 60), home('atlas', courts, 5 * 60),
  row('mono:onboarding', onboarding, { branch: 'atl-212-onboarding-validation', linearIssue: 'ATL-212', pr: { number: 4180, state: 'open', url: 'https://example.com/pr/4180', checks: 'success' } }),
  row('mono:onboarding', webfix, { branch: 'atl-212-onboarding-validation' }),
  row('mono:onboarding', deeplink, { branch: 'atl-212-onboarding-validation' }),
  row('mono:hours', hours, { branch: 'atl-219-weekly-hours', linearIssue: 'ATL-219', lastActivityAt: T - 12 * MIN }),
  row('flow:usage', usage, { repo: 'flow-lab', branch: 'usage-report-export', lastActivityAt: T - 4 * MIN }),
  ...Array.from({ length: 12 }, (_, i) => ({ ...row(`idle:${i}`, agent(`idle-${i}`, 'codex', `idle ${i}`)), agents: [], name: `fixture-branch-${i + 1}`, repo: 'mono', createdAt: i }))
]
const member = (a, ws) => ({ id: JSON.stringify([ws, 'session', a.orcaSession]), workspaceId: ws, orcaSession: a.orcaSession, agentType: a.agentType, title: a.title, paneKey: a.paneKey, terminals: [a.terminal], resumeSessionId: `provider-${a.paneKey}`, lastAgent: a, agent: a })
const coordinator = (key, name, repos, session, look) => {
  const ws = `folder:${key}`, m = member(session, ws)
  return { key, name, repos, workspaceId: ws, session, sessions: { version: 1, current: m.id, members: [m] }, members: [m], look }
}
const harborLast = agent('harbor-main', 'codex', 'Harbor coordination', { coordinator: 'harbor', live: false, dispatch: null })
const harborMember = { ...member(harborLast, 'folder:harbor'), agent: null }
const snapshot = {
  source: 'cli', ready: true, focusedPanes: ['term_hours'], handoverProviders: ['claude', 'codex'],
  coordinatorProviders: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }],
  capacity: { verdict: 'ok', freeGB: 11.4, marginGB: 2, diskFreeGB: 312, agentGB: 0.5, envGB: 1.5, pressure: 'normal', finishedOpen: 2 },
  features: { goals: true, linear: true, tokenSpeed: true },
  skillReload: ['intake', 'courts', 'deeplink', 'atlas-main', 'lab-main', 'usage'].map((pane) => ({ pane, state: 'waiting', role: 'lead', provider: 'claude', at: T - 2 * MIN, expiresAt: T + H })),
  coordinators: [
    coordinator('atlas', 'atlas', [], atlasMain, { color: '#e8774a', shape: 'pentagon' }),
    coordinator('flow-lab', 'flow-lab', ['flow-lab'], labMain, { color: '#a66bf2', shape: 'shield' }),
    { key: 'harbor', name: 'harbor', repos: [], workspaceId: 'folder:harbor', session: null, sessions: { version: 1, current: harborMember.id, members: [harborMember] }, members: [harborMember], look: { color: '#1f6f78', shape: 'hex' } }
  ],
  rows
}
const goal = (id, title, next, steps, over = {}) => ({ id, title, next, steps: steps.map(([text, done]) => ({ text, done: !!done })), links: { linear: [], worktrees: [] }, status: 'open',
  createdAt: T - 5 * 24 * H, updatedAt: T - 2 * H, lastChange: { by: 'you', field: 'next', at: T - 2 * H }, workingPanes: [], ...over })
const goals = [
  goal('g1', 'Ship role-based workspace access', 'Check where the ATL-212 lead is', [['Access matrix', 0], ['Moderation rights', 0], ['Audit log', 0], ['Review', 0]]),
  goal('g2', 'Finish splitting long lessons into short ones', 'Check CI for PR #4180 after the review fixes.', []),
  goal('g3', 'Rota templates for two regions, ready for legal review', 'Draft the first template', [['First template', 0], ['Second template', 0], ['Sent for review', 0], ['Feedback in', 0]]),
  goal('g4', 'Compare other products before planning auto-fill for rotas', 'List the products to analyze', [])
]
const hist = emptyHistory()
for (let m = 0; m < 50; m++) addResponse(hist, { model: 'claude-opus-5-5', out: 900 + (m * 137) % 700, start: T - (50 - m) * MIN, end: T - (50 - m) * MIN + 30_000 }, T)
const speedWire = speedView(hist, T, { ready: true })
const linearWire = { wire: 1, urlBase: 'https://linear.example/issue/', me: 'u1', teams: ['ATL', 'OPS'], cycles: [], sent: {}, lastSent: {}, at: T,
  states: [['In Progress', 'started', '#f2c94c'], ['Todo', 'unstarted', '#e2e2e2']], projects: [['Access', '#5e6ad2']], people: [['u1', 'You']], cycleIds: [],
  issues: Array.from({ length: 13 }, (_, i) => [`ATL-${230 + i}`, `Fixture issue ${i + 1}`, 2, i % 2, 0, 0, -1, Math.floor(T / 1000)]) }
const settings = {
  version: '0.2.98', error: null, writers: [{ provider: 'claude', lastSuccessAt: T - 2 * MIN, failure: null, installed: true }, { provider: 'codex', lastSuccessAt: null, failure: null, installed: true }],
  availability: { agents: ['claude', 'codex'], models: { claude: null, codex: null } },
  settings: { writers: [{ provider: 'claude', model: 'haiku', enabled: true }, { provider: 'codex', model: 'gpt-6-luna', enabled: true }], messageFormat: [], marginGB: 2, warnHeadroomGB: 2, linearDryRun: false,
    features: { bots: false, goals: true, linear: true, tokenSpeed: true },
    routing: { coordinator: { agent: 'codex', model: 'gpt-6-astra', effort: 'high' }, lead: null, workers: { simple: { model: { agent: 'claude', model: 'haiku' }, fallback: null }, normal: { model: { agent: 'codex', model: 'gpt-6-astra', effort: 'medium' }, fallback: null }, hard: { model: { agent: 'claude', model: 'opus', effort: 'high' }, fallback: null } }, types: [], presets: [] } }
}

// ---- The bridge: a stub `orca` (never live state), then the proposal for the state in the URL.
const json = (v) => JSON.stringify(v).replaceAll('<', '\\u003c')
const bridge = `<style>.tip{transition:none!important}
/* Proposal: the only CSS this draft adds. It reuses the panel's tokens. */
.r > .acct{align-self:baseline;display:inline-flex;align-items:center;gap:3px;color:var(--faint);font-size:11px;white-space:nowrap}
.r > .acct svg{width:11px;height:11px;flex:none;align-self:center}
.acct-line .act{margin-left:auto;font-size:11px}
.acct-note{margin:0;padding:0 10px;font-size:11.5px;color:var(--muted)}
</style><script>
'use strict';
const q = new URLSearchParams(location.search);
// Orca's dark theme as the live sidebar shows it (only what the panel reads from Orca).
document.documentElement.style.setProperty('--orca-background', '#000');
const NOW = ${T};
Date.now = () => NOW;
const snapshot = ${json(snapshot)};
const goals = ${json(goals)};
const settings = ${json(settings)};
// ---- Account fixture (made-up identities and readings). Atlas may share context within the Studio organization.
//   state=healthy | included (fresh 100% included reading, paid capacity left, no error) | switched (destination
//   verified) | spent (every eligible login's included usage used up) | notproof (&reason=rounded|stale|othermodel|retry)
//   | scope (sharing scope unknown) | settings (&page=accounts|models)
//   trigger=included (default) | error (a hard usage-limit error, the fallback)
const STATE = ['healthy','included','switched','spent','notproof','scope','settings'].includes(q.get('state')) ? q.get('state') : 'healthy';
const TRIGGER = q.get('trigger') === 'error' ? 'error' : 'included';
const PROVIDER = q.get('provider') === 'codex' ? 'codex' : 'claude';
const HOST = q.get('host') === 'today' ? 'today' : 'ready';
const SCOPE = 'Studio';
// included: the fresh, attributable reading of the included window that applies to this model and login.
const DISCOVERED = {
  claude: [{ id: 'sd', alias: 'c1', label: 'System default' },
    { id: 'c1', email: 'dev@studio.example', org: 'Studio', included: 100, window: '5-hour', reset: '3:45 PM', at: 945, paid: true },
    { id: 'c2', email: 'qa@studio.example', org: 'Studio', included: 38, window: '5-hour', reset: '6:10 PM', at: 1090, paid: true }],
  codex: [{ id: 'x1', email: 'dev@studio.example', org: 'Studio', included: 100, window: '5-hour', reset: '4:20 PM', at: 980, paid: true },
    { id: 'x2', email: 'ops@studio.example', org: 'Studio', included: 31, window: '5-hour', reset: '5:05 PM', at: 1025, paid: true },
    { id: 'x3', email: 'contractor@acme.example', org: 'Acme', included: 0, window: '5-hour', reset: '2:30 PM', at: 870, paid: true }]
};
const NOT_PROOF = {
  rounded: 'The window shows 100%, but the reading is 99.6%: a rounded display is not proof.',
  stale: 'The last reading is 41 minutes old: stale or unknown usage is not proof.',
  othermodel: 'Only a window for another model is at 100%; this conversation’s model still has included usage.',
  retry: 'A temporary error (HTTP 429) is being retried: not a usage signal.'
};
const REASON = Object.keys(NOT_PROOF).includes(q.get('reason')) ? q.get('reason') : 'rounded';
const TARGET = PROVIDER === 'claude' ? 'onboarding' : 'usage';
const NAME = { claude: 'Claude', codex: 'Codex' };
const logins = (p) => { const d = DISCOVERED[p]; return d.filter((a) => !a.alias).map((a) => ({ ...a, systemDefault: d.some((x) => x.alias === a.id) })); };
const excluded = new Set(JSON.parse(q.get('exclude') || '[]'));
let switching = q.get('switching') !== 'off';
const eligible = (p) => logins(p).filter((a) => a.org === SCOPE && !excluded.has(a.id));
const short = (email) => email.replace(/\\.example$/, '');
// What the host does with the conversation, for its face: paused or limited turns end (done), others keep working.
function paused() {
  if (HOST === 'today') return TRIGGER === 'error' && ['included','switched','spent','scope'].includes(STATE);
  if (!switching) return TRIGGER === 'error' && ['included','switched','spent','scope'].includes(STATE);
  return STATE === 'spent' || STATE === 'scope' || (['included','switched'].includes(STATE) && eligible(PROVIDER).length < 2);
}
if (paused()) for (const r of snapshot.rows) for (const a of r.agents) if (a.paneKey === TARGET) { a.state = 'done'; r.state = 'done'; }
const stored = { 'linear': { folded: true }, 'speed-ui': { folded: true }, 'goals-ui': { folded: false }, 'folded': ['idle'] };
window.previewCalls = [];
window.previewErrors = [];
window.addEventListener('error', (e) => previewErrors.push(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => previewErrors.push(e.reason?.stack || String(e.reason)));
window.orca = {
  plugin: {
    request: async (name, data) => {
      previewCalls.push({ name, data });
      if (name === 'sidebar.list') return structuredClone(snapshot);
      if (name === 'sidebar.goals') return structuredClone(goals);
      if (name === 'sidebar.linear') return ${json(linearWire)};
      if (name === 'sidebar.tokenSpeed') return ${json(speedWire)};
      if (name === 'sidebar.settings') return structuredClone(settings);
      if (name === 'sidebar.checkUpdates') return { kind: 'current', current: '0.2.98', latest: '0.2.98', at: NOW };
      return { ok: true };
    },
    on: () => () => {}
  },
  storage: { get: async (k) => stored[k] ?? null, set: async () => {} }, shell: { openExternal: async () => {} }
};

// ---- Proposal. Healthy adds nothing. Each other state adds the smallest thing the decision needs.
const SWAP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5h8.5M9 3l2.5 2.5L9 8M13 10.5H4.5M7 8l-2.5 2.5L7 13"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.5 5.8v4.4M9.5 5.8v4.4"/></svg>';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let checked = false;
function outcome() {
  const p = PROVIDER, src = logins(p)[0], name = NAME[p];
  if (STATE === 'healthy' || STATE === 'settings' || STATE === 'notproof') return null;
  const used = src.email + ' has used 100% of its included ' + src.window + ' usage (resets ' + src.reset + ')';
  const limited = { status: 'Limited · ' + src.reset, tip: src.email + ' reached its usage limit. The conversation continues here after the reset at ' + src.reset + '.' };
  // Orca 1.4.272, or switching turned off: Orca Flow doesn't act. At 100% included the provider keeps going on
  // paid usage, so nothing changes; a hard usage-limit error shows only as the row's status.
  if (HOST === 'today' || !switching) return TRIGGER === 'error' ? limited : null;
  const pausedLine = (why) => ({ status: 'Paused · ' + src.reset, tip: (TRIGGER === 'error' ? src.email + ' reached its usage limit' : used) + '. ' + why + ' Work paused before its next request so it doesn’t run on paid usage.' });
  if (STATE === 'scope') return { ...pausedLine('Orca couldn’t confirm which accounts may receive this workspace’s work.'), line: name + ': couldn’t confirm which accounts may receive this work · paused before paid usage' };
  const others = eligible(p).filter((a) => a.id !== src.id);
  if ((STATE === 'included' || STATE === 'switched') && others.length) {
    const to = others[0];
    if (STATE === 'included') return { moving: 'Moving to ' + short(to.email), tip: used + '. It could go on paid usage, but this work moves to ' + to.email + ', which has included usage left, before its next request.' };
    return { acct: short(to.email), tip: 'Continued on ' + to.email + (TRIGGER === 'error' ? ': ' + src.email + ' reached its usage limit (resets ' + src.reset + ').' : ' before paid usage: ' + used + '.') + ' Same conversation, model and assignment.' };
  }
  if (STATE === 'included' || STATE === 'switched') return { ...pausedLine('No other ' + name + ' login this work may use has included usage left.'), line: name + ': no other account has included usage · paused before paid usage · ' + src.reset };
  // spent: every eligible login is at 100% of its included usage. One line, the earliest known reset, no cycling.
  const pool = [src, ...others], first = [...pool].sort((a, b) => a.at - b.at)[0];
  const tip = TRIGGER === 'error'
    ? 'All ' + pool.length + ' ' + name + ' accounts for this work are limited. It continues on ' + first.email + ' at ' + first.reset + ', the earliest reset.'
    : pool.map((a) => a.email).join(' and ') + ' have used all of their included usage. Work paused before its next request so it doesn’t run on paid usage. It continues on ' + first.email + ' at ' + first.reset + ', the earliest reset.';
  return { status: (TRIGGER === 'error' ? 'Limited · ' : 'Paused · ') + first.reset, tip,
    line: TRIGGER === 'error' ? name + ': all ' + pool.length + ' accounts limited · resumes ' + first.reset + ' on ' + short(first.email) : name + ': included usage used up · paused before paid usage · ' + first.reset };
}
function applyRow(o) {
  const el = document.querySelector('#main [data-menu="agent:' + TARGET + '"]');
  if (!el || el.querySelector('.acct, .acct-status')) return;
  const r = el.querySelector('.r');
  if (!r) return;
  if (o.acct) {
    const span = document.createElement('span');
    span.className = 'acct'; span.setAttribute('role', 'img'); span.setAttribute('aria-label', o.tip); span.dataset.tip = o.tip;
    span.innerHTML = SWAP + esc(o.acct);
    r.insertBefore(span, r.querySelector('.age'));
  } else if (o.moving) {
    r.innerHTML = '<span class="rstatus pending acct-status" data-tip="' + esc(o.tip) + '"><span class="refreshing"></span>' + esc(o.moving) + '<span class="sr-only">: ' + esc(o.tip) + '</span></span>';
  } else {
    r.innerHTML = '<span class="rstatus warn acct-status" data-tone="warn" data-tip="' + esc(o.tip) + '">' + esc(o.status) + '<span class="sr-only">: ' + esc(o.tip) + '</span></span>';
  }
}
function applyLine(o) {
  if (!o.line || document.querySelector('#main .acct-line')) return;
  const label = document.querySelector('#main .tlabel');
  if (!label) return;
  const after = label.nextElementSibling?.classList.contains('reload-sum') ? label.nextElementSibling : label;
  const div = document.createElement('div');
  div.className = 'reload-sum acct-line'; div.setAttribute('role', 'status'); div.dataset.tip = o.tip;
  div.innerHTML = PAUSE + '<span>' + esc(o.line + (checked ? ' · checked just now' : '')) + '</span><button class="act" data-acct-check>Check now</button>';
  after.after(div);
}

// ---- Settings: Account switching, its own page beside Models in the released dialog.
const NAV_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5h8.5M9 3l2.5 2.5L9 8M13 10.5H4.5M7 8l-2.5 2.5L7 13"/></svg>';
let acctOpen = false;
const atDefault = () => switching && excluded.size === 0;
function navButton() {
  const nav = document.getElementById('s-nav');
  const models = nav?.querySelector('[data-page="models"]');
  if (!models || nav.querySelector('[data-acct-page]')) return;
  const narrow = window.innerWidth <= 520;
  const b = document.createElement('button');
  b.className = 's-nav-btn'; b.type = 'button'; b.dataset.acctPage = ''; b.setAttribute('aria-label', 'Account switching');
  if (narrow) b.dataset.tip = 'Account switching';
  b.innerHTML = '<span class="s-tile" style="background:#0f9d8a">' + NAV_ICON + '</span><span class="s-nav-label">Account switching</span>';
  models.after(b);
}
function accountsPage() {
  const tip = (t) => ' data-tip="' + esc(t) + '"';
  const sw = (id, on, name, dis) => '<label class="s-switch"><input type="checkbox" role="switch" data-acct="' + id + '" ' + (on ? 'checked' : '') + (dis ? ' disabled' : '') + ' aria-label="' + esc(name) + '"><span></span></label>';
  const rowHtml = (p, a) => {
    const inScope = a.org === SCOPE;
    const detail = inScope ? (a.systemDefault ? 'System default' : '') : 'Not shared';
    const t = inScope ? a.org + (a.systemDefault ? ', also System default' : '') + '. Used when another ' + NAME[p] + ' login has used 100% of its included usage. Off: never used.' : 'Discovered, but no workspace here may share context with ' + a.org + ', so it is never used.';
    return '<div class="s-row"><span class="s-label"' + tip(t) + '>' + esc(a.email) + '</span><div class="s-ctl">' + (detail ? '<span class="s-value">' + esc(detail) + '</span>' : '') + sw(a.id, inScope && !excluded.has(a.id), a.email, !inScope || !switching) + '</div></div>';
  };
  return '<div class="acct-page" style="display:contents"><h3 class="s-ptitle"><span class="s-label"' + tip('Which logins a conversation may continue on when its account has used its included usage.') + '>Account switching</span></h3>' +
    '<section class="s-group"><div class="s-card"><div class="s-row"><span class="s-label"' + tip('Off: Orca Flow doesn’t step in, so an account at 100% goes on to paid usage as the provider allows.') + '>Continue on another account</span><div class="s-ctl">' + sw('all', switching, 'Continue on another account') + '</div></div></div>' +
    '<p class="acct-note">On by default for every eligible Claude and Codex login. When a login has used 100% of its included usage, work moves to another login of the same provider that still has included usage, before its next paid request. When none has any, work pauses until a reset.</p></section>' +
    ['claude', 'codex'].map((p) => '<section class="s-group"><h4 class="s-gh"><span class="s-label">' + NAME[p] + '</span></h4><div class="s-card">' + logins(p).map((a) => rowHtml(p, a)).join('') + '</div></section>').join('') +
    (atDefault() ? '' : '<div class="s-foot"><button type="button" class="s-push" data-acct-reset>Reset to Defaults</button></div>') + '</div>';
}
function showAccounts() {
  const page = document.getElementById('s-page'), nav = document.getElementById('s-nav');
  if (!page || !nav) return;
  navButton();
  for (const b of nav.querySelectorAll('.s-nav-btn')) b.removeAttribute('aria-current');
  nav.querySelector('[data-acct-page]')?.setAttribute('aria-current', 'page');
  page.innerHTML = accountsPage();
  page.scrollTop = 0;
}
function applySettings() {
  if (document.getElementById('settings')?.hidden) return;
  navButton();
  const page = document.getElementById('s-page');
  if (acctOpen && page && !page.querySelector('.acct-page')) showAccounts();
}
function apply() {
  const o = outcome();
  if (o) { applyRow(o); applyLine(o); }
  applySettings();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-acct-check]')) { e.stopPropagation(); checked = true; document.querySelector('#main .acct-line')?.remove(); apply(); return; }
  if (e.target.closest('[data-acct-page]')) { e.stopPropagation(); acctOpen = true; showAccounts(); return; }
  if (e.target.closest('[data-acct-reset]')) { e.stopPropagation(); switching = true; excluded.clear(); showAccounts(); return; }
  if (e.target.closest('#s-nav [data-page], #s-x')) acctOpen = false;
}, true);
document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-acct]');
  if (!t) return;
  e.stopPropagation();
  if (t.dataset.acct === 'all') switching = t.checked; else t.checked ? excluded.delete(t.dataset.acct) : excluded.add(t.dataset.acct);
  showAccounts(); document.querySelector('[data-acct="' + t.dataset.acct + '"]')?.focus();
}, true);
new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
if (STATE === 'settings') window.addEventListener('load', () => setTimeout(() => {
  document.getElementById('settings-open').click();
  setTimeout(() => q.get('page') === 'models' ? document.querySelector('[data-page="models"]')?.click() : document.querySelector('[data-acct-page]')?.click(), 150);
}, 200));
</script>`

const inline = (s) => s.replace(/<\/script/gi, '<\\/script')
const html = indexHtml
  .replace('<head>', '<head><title>Orca Flow 0.2.98 · account switching preview</title><meta name="viewport" content="width=device-width,initial-scale=1" />')
  .replace('<link rel="stylesheet" href="./panel.css" />', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="./app.ts"></script>', () => `${bridge}<script type="module">\n${inline(appJs)}\n</script>`)
if (html === indexHtml || !html.includes('Account fixture')) throw new Error('index.html changed shape; the preview could not inline the panel')
const outDir = join(root, 'docs/account-failover-preview')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'panel.html'), html)
console.log(`Wrote docs/account-failover-preview/panel.html from the released Orca Flow ${manifest.version}`)
if (html.includes(homedir())) throw new Error('The preview would embed a local home path')

// ---- Optional: capture every state at the live capture's size and run the checks.
const shotsAt = process.argv.indexOf('--shots')
if (shotsAt > 0) await shoot(process.argv[shotsAt + 1], process.argv.includes('--reference') ? process.argv[process.argv.indexOf('--reference') + 1] : null)

async function shoot(out, reference) {
  mkdirSync(out, { recursive: true })
  const W = 572, Hh = 1348, ZOOM = 1.1 // Orca draws the panel at 110%: 572 CSS px is the live 629 px capture
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(join(tmpdir(), 'orca-flow-account-chrome-'))
  const port = 9400 + Math.floor(Math.random() * 400)
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let targets
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === 'page')) break } catch {} await sleep(200) }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0; const pending = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const ev = async (expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value }
  await cdp('Page.enable'); await cdp('Network.enable'); await cdp('Network.setCacheDisabled', { cacheDisabled: true })
  const url = (query) => pathToFileURL(join(outDir, 'panel.html')).href + '?' + query
  const load = async (query, w = W, h = Hh) => { await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: w === W ? ZOOM : 1, mobile: false }); await cdp('Page.navigate', { url: url(query) }); await sleep(1300) }
  const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); const f = join(out, name + '.png'); writeFileSync(f, Buffer.from(r.result.data, 'base64')); return f }
  let pass = 0, fail = 0
  const check = (name, ok, got) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got: ${String(JSON.stringify(got)).slice(0, 300)}`}`) }
  // The panel's drawn regions, with the tooltip layer and transient ids left out.
  const regions = `JSON.stringify(['cockpit','goals','main','attention','linear','tokenspeed','footer'].map(id => document.getElementById(id)?.outerHTML))`
  const files = []

  await load('state=healthy')
  const healthy = await ev(regions)
  files.push(await shot('01-healthy'))
  const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`)
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`)
  const tipOf = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.dataset.tip ?? ''`)
  check('healthy: no proposal element', (await count('.acct,.acct-status,.acct-line,.acct-page')) === 0)
  check('healthy: Goals, Coordinators tree, Linear, Analytics and Idle drawn by the released panel', await ev(`['#goals-rows .g','#main .tlabel','#main .coord','#linear','#tokenspeed','#footer'].every(s => document.querySelector(s))`))
  check('healthy: no page errors', (await ev('previewErrors.length')) === 0, await ev('previewErrors'))

  for (const [name, query] of [['02-included-100-paid-left', 'state=included'], ['03-switched-verified', 'state=switched'], ['04-spent-paused', 'state=spent'],
    ['05-not-proof-rounded', 'state=notproof&reason=rounded'], ['06-scope-unknown', 'state=scope'], ['07-switched-codex', 'state=switched&provider=codex'],
    ['08-spent-codex', 'state=spent&provider=codex'], ['09-limit-error-host-today', 'state=switched&trigger=error&host=today']]) {
    await load(query); files.push(await shot(name))
    check(`${name}: no page errors`, (await ev('previewErrors.length')) === 0, await ev('previewErrors'))
  }
  // Not proof: a rounded 100, a stale reading, another model's window or a retry change nothing.
  for (const reason of ['rounded', 'stale', 'othermodel', 'retry']) {
    await load('state=notproof&reason=' + reason)
    check(`not proof (${reason}): the panel is identical to healthy`, (await ev(regions)) === healthy)
  }
  // 100% included, paid capacity left, no error: the work moves before its next request.
  await load('state=included')
  check('included 100%: the row says Moving to qa@studio', (await text('[data-menu="agent:onboarding"] .acct-status')).startsWith('Moving to qa@studio'))
  check('included 100%: its tooltip says it could go on paid usage but moves first', (await tipOf('.acct-status')).includes('It could go on paid usage, but this work moves to qa@studio.example, which has included usage left, before its next request'))
  check('included 100%: no line, no prompt', (await count('.acct-line,dialog[open]')) === 0)
  // Verified destination: one faint label; everything else identical to healthy.
  await load('state=switched')
  check('switched: one account label on the onboarding row', (await ev(`[...document.querySelectorAll('.acct')].map(e => e.closest('[data-menu]').dataset.menu + '|' + e.textContent).join()`)) === 'agent:onboarding|qa@studio')
  check('switched: the record says before paid usage', (await tipOf('.acct')).startsWith('Continued on qa@studio.example before paid usage: dev@studio.example has used 100% of its included 5-hour usage'))
  check('switched: everything else identical to healthy', (await ev(`document.querySelectorAll('.acct').forEach(e => e.remove()), ${regions}`)) === healthy)
  await load('state=switched&trigger=error')
  check('fallback: a hard usage-limit error still switches', (await tipOf('.acct')).startsWith('Continued on qa@studio.example: dev@studio.example reached its usage limit'))
  // All eligible included usage used up: pause before paid usage, earliest reset, no cycling.
  await load('state=spent')
  check('spent: the row says Paused · 3:45 PM', (await text('[data-menu="agent:onboarding"] .acct-status')).startsWith('Paused · 3:45 PM'))
  check('spent: one line, paused before paid usage, earliest reset', (await ev(`[...document.querySelectorAll('.acct-line')].map(e => e.textContent).join('|')`)) === 'Claude: included usage used up · paused before paid usage · 3:45 PMCheck now')
  await ev(`document.querySelector('[data-acct-check]').click()`); await sleep(100)
  check('spent: Check now answers in place', (await text('.acct-line')).includes('checked just now'))
  await load('state=spent&provider=codex')
  check('codex spent: the Acme login is never counted (earliest in scope is 4:20 PM, not 2:30 PM)', (await text('.acct-line')).endsWith('· 4:20 PMCheck now') && !(await tipOf('.acct-line')).includes('acme'))
  await load('state=switched&provider=codex')
  check('codex switched: continues on ops@studio, never contractor@acme', (await text('[data-menu="agent:usage"] .acct')) === 'ops@studio')
  await load('state=scope')
  check('scope unknown: paused before paid usage and says why', (await text('.acct-line')).startsWith('Claude: couldn’t confirm which accounts may receive this work · paused before paid usage'))
  await load('state=included&exclude=["c2"]')
  check('excluded backup: no other login has included usage, so paused', (await text('.acct-line')).startsWith('Claude: no other account has included usage · paused before paid usage'))
  // Orca 1.4.272 and switching off: Orca Flow doesn't act. At 100% included nothing changes (paid usage goes on).
  await load('state=included&host=today')
  check('host today, 100% included: nothing changes (the provider goes on to paid usage)', (await ev(regions)) === healthy)
  await load('state=switched&trigger=error&host=today')
  check('host today, usage-limit error: only the row status', (await count('.acct-line,.acct')) === 0 && (await text('.acct-status')).startsWith('Limited · 3:45 PM'))
  await load('state=included&switching=off')
  check('switching off, 100% included: nothing changes', (await ev(regions)) === healthy)
  // Settings: Account switching is its own page beside Models; Models has no account section.
  await load('state=settings'); await sleep(500)
  files.push(await shot('10-settings-account-switching'))
  check('settings: Account switching is the nav item right after Models', (await ev(`[...document.querySelectorAll('#s-nav .s-nav-btn')].map(b => b.getAttribute('aria-label')).join('|')`)) === 'Titles & Summaries|Models|Account switching|Message Check|Memory|Features|Advanced|About')
  check('settings: the deep link opens Account switching', (await ev(`document.querySelector('#s-nav [aria-current="page"]').getAttribute('aria-label')`)) === 'Account switching' && (await text('#s-page .s-ptitle')) === 'Account switching')
  check('settings: the page says all eligible logins are used by default at 100% included usage', (await text('.acct-note')).startsWith('On by default for every eligible Claude and Codex login. When a login has used 100% of its included usage'))
  check('settings: one master switch, on', (await ev(`document.querySelector('[data-acct="all"]').checked`)) === true)
  check('settings: two Claude rows (System default collapsed), three Codex rows', (await ev(`[...document.querySelectorAll('.acct-page .s-card')].slice(1).map(c => c.querySelectorAll('.s-row').length).join()`)) === '2,3')
  check('settings: System default and Not shared only as notes', (await ev(`[...document.querySelectorAll('.acct-page .s-value')].map(e => e.textContent).join()`)) === 'System default,Not shared')
  check('settings: every in-scope login on, Acme disabled', (await ev(`[...document.querySelectorAll('[data-acct]:not([data-acct=all])')].map(i => i.dataset.acct + (i.checked ? '1' : '0') + (i.disabled ? 'd' : '')).join()`)) === 'c11,c21,x11,x21,x30d')
  check('settings: no usage or cost figures on the page', !/\d+%|\$|credit/i.test(await text('.acct-page')) || (await text('.acct-page')).replace('100% of its included usage', '').match(/\d+%|\$|credit/i) === null)
  check('settings: no Reset to Defaults at the defaults', (await count('[data-acct-reset]')) === 0)
  await ev(`document.querySelector('[data-page="models"]').click()`); await sleep(300)
  files.push(await shot('11-settings-models'))
  check('settings: Models opens the released Models page', (await ev(`document.querySelector('#s-nav [aria-current="page"]').dataset.page`)) === 'models')
  check('settings: Models has no account-switching section', (await count('#s-page .acct-page,#s-page [data-acct]')) === 0 && !(await text('#s-page')).includes('Account switching'))
  check('settings: the nav keeps Account switching while on Models', (await count('#s-nav [data-acct-page]')) === 1)
  await ev(`document.querySelector('[data-acct-page]').click()`); await sleep(200)
  check('settings: back to Account switching', (await text('#s-page .s-ptitle')) === 'Account switching' && (await count('#s-nav [aria-current="page"]')) === 1)
  await ev(`document.querySelector('[data-acct="c2"]').click()`); await sleep(100)
  check('settings: excluding a login shows Reset to Defaults', (await count('[data-acct-reset]')) === 1 && (await ev(`document.querySelector('[data-acct="c2"]').checked`)) === false)
  await ev(`document.querySelector('[data-acct="all"]').click()`); await sleep(100)
  check('settings: turning it off disables the logins', (await ev(`[...document.querySelectorAll('[data-acct]:not([data-acct=all])')].every(i => i.disabled)`)) === true)
  await ev(`document.querySelector('[data-acct-reset]').click()`); await sleep(100)
  check('settings: Reset to Defaults turns it back on for every in-scope login', (await ev(`[...document.querySelectorAll('[data-acct]')].filter(i => !i.disabled && i.checked).length`)) === 5 && (await count('[data-acct-reset]')) === 0)
  await load('state=settings&page=models'); await sleep(500)
  check('settings: the Models deep link has no account section', (await ev(`document.querySelector('#s-nav [aria-current="page"]').dataset.page`)) === 'models' && (await count('#s-page [data-acct]')) === 0)
  check('settings: the panel saved nothing', (await ev(`previewCalls.filter(c => c.name === 'sidebar.saveSettings').length`)) === 0)
  check('settings: no page errors', (await ev('previewErrors.length')) === 0, await ev('previewErrors'))

  // The review page at the previous URL: controls outside the product, the panel in a frame.
  const review = (query) => pathToFileURL(join(root, "docs/account-failover-prototype.html")).href + query
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1120, height: 1560, deviceScaleFactor: 1, mobile: false })
  await cdp("Page.navigate", { url: review("?placement=limit") }); await sleep(1500)
  check("review: the old ?placement=limit URL opens the paused state", (await ev("new URLSearchParams(location.search).get('state')")) === "spent")
  check("review: the frame is the released panel", (await ev("document.getElementById('frame').contentDocument.title")).startsWith("Orca Flow 0.2.98"))
  check("review: the frame shows the paused line", (await ev("document.getElementById('frame').contentDocument.querySelectorAll('.acct-line').length")) === 1)
  await ev("document.querySelector('a[data-value=switched]').click()"); await sleep(1500)
  check("review: picking Switched updates the URL and the frame", (await ev("location.search")).includes("state=switched") && (await ev("document.getElementById('frame').contentDocument.querySelectorAll('.acct').length")) === 1)
  files.push(await shot("10-review-page"))
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true })
  await cdp("Page.navigate", { url: review("?state=healthy") }); await sleep(1200)
  check("review: no horizontal scroll at phone width", (await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth")) <= 0)

  // Side by side with the live capture (local only, never published).
  if (reference && existsSync(reference)) {
    copyFileSync(reference, join(out, '00-reference.png'))
    const page = join(out, 'compare.html')
    writeFileSync(page, `<!doctype html><body style="margin:0;background:#222;display:flex;gap:16px;padding:16px;font:12px -apple-system;color:#aaa">${[['Installed 0.2.98 (live)', '00-reference.png'], ['Preview: healthy', '01-healthy.png'], ['Preview: 100% included, paid left', '02-included-100-paid-left.png'], ['Preview: all included used up', '04-spent-paused.png']].map(([t, f]) => `<figure style="margin:0"><figcaption style="margin-bottom:6px">${t}</figcaption><img src="${f}" width="629"></figure>`).join('')}</body>`)
    await cdp('Emulation.setDeviceMetricsOverride', { width: 4 * 629 + 80, height: 1483 + 60, deviceScaleFactor: 1, mobile: false })
    await cdp('Page.navigate', { url: pathToFileURL(page).href }); await sleep(800)
    files.push(await shot('09-compare'))
  }
  ws.close(); proc.kill(); await sleep(500); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  console.log(`\n${pass} passed, ${fail} failed\n${files.join('\n')}`)
  if (fail) process.exitCode = 1
}
