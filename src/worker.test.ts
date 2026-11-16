// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'
import { nextTarget, waitingQueue } from './rank.ts'
import { assignCoordinators, COORDINATOR_FILE, deleteFolder, isCoordinatorHome, readCoordinators, scaffoldCoordinator, validateName, writeLook } from './coordinators.ts'
import { buildCockpit, removeWorktree } from './cockpit.ts'

const ps: main.PsWorktree[] = [
  {
    identity: { key: 'wt2:local:a' }, displayName: 'live-preview', repo: 'shop',
    branch: 'refs/heads/me/live-preview', liveTerminalCount: 2, lastActivityAt: 5,
    agents: [
      { state: 'done', agentType: 'claude', conversationName: 'Old task' },
      { state: 'waiting', agentType: 'claude', conversationName: 'Live preview design' }
    ]
  },
  { identity: { key: 'wt2:local:b' }, displayName: 'gone', repo: 'shop', isArchived: true },
  { identity: { key: 'wt2:local:c' }, displayName: 'main', repo: 'tools', agents: [] }
]

test('maps the CLI snapshot: ids, most urgent state, archived dropped', () => {
  const rows = main.fromPs(ps)
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.state, r.branch]), [
    ['identity:wt2:local:a', 'live-preview', 'waiting', 'me/live-preview'],
    ['identity:wt2:local:c', 'main', null, null]
  ])
  assert.equal(rows[0].agents.length, 2)
})

test('merges coordinator cards and hook summaries by worktree and pane', () => {
  const withPanes: main.PsWorktree[] = [
    { identity: { key: 'wt2:local:a' }, displayName: 'x', repo: 'shop', agents: [{ paneKey: 'tab:leaf', state: 'done', conversationName: 'Old name' }] },
    { identity: { key: 'wt2:local:b' }, displayName: 'y', repo: 'shop', agents: [{ paneKey: 'tab:other', state: 'done' }] }
  ]
  const store: main.Store = {
    cards: { 'wt2_local_a': { priority: 'P0', goal: 'Stop the outage' } },
    summaries: {
      'tab_leaf': { title: 'Outage fix', goal: '', since: 'Rolled back', needs: { type: 'approval', ask: 'Deploy?', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1 },
      'tab_other': { title: 'Docs', goal: '', since: '', needs: { type: 'none', ask: '', options: [] }, effort: 'deep', priority: 'P3', role: 'solo', updatedAt: 1 }
    }
  }
  const [a, b] = main.fromPs(withPanes, store)
  assert.equal(a.priority, 'P0') // the card wins over the summary's guess
  assert.equal(a.agents[0].title, 'Outage fix')
  assert.equal(a.agents[0].summary?.needs.ask, 'Deploy?')
  assert.equal(b.priority, 'P3') // no card: the summary's guess
})

test('falls back to workspace.list when the CLI fails', async () => {
  const workspaces = [{ id: 'x', kind: 'worktree', name: 'main', path: '/u/projects/shop', branch: 'refs/heads/main', hostId: 'local' }]
  const logs: string[] = []
  const orca = { host: { call: async () => ({ workspaces, truncated: false }) }, log: (m: string) => logs.push(m) }
  const answer = await main.snapshot(orca as never, () => Promise.reject(new Error('no cli')))
  assert.equal(answer.source, 'api')
  assert.deepEqual(answer.rows.map((r) => [r.id, r.repo, r.state]), [['x', 'shop', null]])
  assert.equal(logs.length, 1)
})

test('opens a workspace through the host', async () => {
  const host = mockHost({ results: { 'workspace.open': { opened: true } } })
  const worker = await mountWorker(main, { host })
  await worker.request('sidebar.open', { workspaceId: 'identity:wt2:local:a' })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'identity:wt2:local:a' }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test("opening an agent shows its own tab, not the worktree's last one", async () => {
  const opened: unknown[] = []
  const logs: string[] = []
  const orca = { host: { call: async (_: string, params: unknown) => (opened.push(params), { opened: true }) }, log: (m: string) => logs.push(m) }
  const ran: string[][] = []
  const run = async (args: string[]) => { ran.push(args); return {} }
  await main.openAgent(orca as never, run, { workspaceId: 'identity:w', terminal: 'term-worker' })
  assert.deepEqual(opened, [{ workspaceId: 'identity:w' }])
  assert.deepEqual(ran, [['terminal', 'switch', '--terminal', 'term-worker']])
  // A session that slept has no terminal: the workspace alone.
  await main.openAgent(orca as never, run, { workspaceId: 'identity:w' })
  assert.equal(ran.length, 1)
  // A failed switch still leaves the workspace open, and says why.
  assert.deepEqual(await main.openAgent(orca as never, () => Promise.reject(new Error('no such terminal')), { workspaceId: 'identity:w', terminal: 'gone' }), { opened: true })
  assert.match(logs[0], /terminal switch failed: no such terminal/)
})

test('jump goes to the top, and pressing again moves past an item just opened', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'r', agents: [{ paneKey: 'pa', state: 'waiting' }], lastActivityAt: 1 },
    { identity: { key: 'b' }, displayName: 'b', repo: 'r', agents: [{ paneKey: 'pb', state: 'blocked' }], lastActivityAt: 2 }
  ])
  const queue = waitingQueue(rows)
  assert.equal(nextTarget(queue, null, 0)?.id, 'identity:a')
  assert.equal(nextTarget(queue, { id: 'identity:a', at: 0 }, 1000)?.id, 'identity:b')
  assert.equal(nextTarget(queue, { id: 'identity:b', at: 0 }, 1000)?.id, 'identity:a', 'wraps around')
  assert.equal(nextTarget(queue, { id: 'identity:a', at: 0 }, 11 * 60_000)?.id, 'identity:a', 'an old jump starts over')
  assert.equal(nextTarget([], null, 0), undefined)
})

test('capacity and the status bar item come from the same rows', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'shop', liveTerminalCount: 1, agents: [{ paneKey: 'pa', state: 'waiting' }, { paneKey: 'pb', state: 'done' }] }
  ])
  const facts = { availableGB: 6.1, totalGB: 16, agentGB: 0.5, envGB: { 'shop': 2.6 }, diskFreeGB: 31 }
  const capacity = main.capacityOf(rows, 'normal', facts, '/nonexistent', () => false)
  assert.deepEqual(capacity, { verdict: 'ok', freeGB: 4.1, marginGB: 2, measuring: false, diskFreeGB: 31, agentGB: 0.5, envGB: 2.6, pressure: 'normal', finishedOpen: 1 })
  const status = main.statusOf({ rows, source: 'cli', capacity, coordinators: [] })
  assert.equal(status.text, '1 waiting')
  assert.match(status.tooltip, /Next: shop\/a/)
  assert.match(status.tooltip, /4\.1 GB free \(after a 2 GB margin\)/)
  const full = main.capacityOf(rows, 'normal', { ...facts, availableGB: 2.3 }, '/nonexistent', () => false)
  assert.equal(full.verdict, 'full')
  assert.equal(main.statusOf({ rows, source: 'cli', capacity: full, coordinators: [] }).text, '1 waiting · memory full')
})

test('your coordinators: their sessions dispatch workers, dispatch chains follow, the rest is yours', () => {
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'alpha', repo: 'alpha', path: '/c/alpha', agents: [{ paneKey: 'p-home', state: 'working' }] },
    { identity: { key: 'a' }, displayName: 'coord', repo: 'shop', agents: [{ paneKey: 'p-coord', state: 'working' }] },
    { identity: { key: 'b' }, displayName: 'dup', repo: 'shop', agents: [{ paneKey: 'p-dup', state: 'working' }] },
    { identity: { key: 'c' }, displayName: 'mine', repo: 'shop', agents: [{ paneKey: 'p-mine', state: 'working' }] }
  ])
  const coordinators = [{ key: 'alpha', name: 'alpha', repos: ['shop'], about: '', dir: '/c/alpha', workspaceId: null }]
  const lineage = {
    dispatcherOf: new Map([['p-coord', 'term-home'], ['p-dup', 'term-coord']]),
    paneOf: new Map([['term-home', 'p-home'], ['term-coord', 'p-coord']])
  }
  const out = assignCoordinators(rows, coordinators, lineage).slice(1).map((r) => [r.agents[0].coordinator, r.agents[0].leadPane])
  assert.deepEqual(out, [['alpha', null], ['alpha', 'p-coord'], ['you', null]])
})

test("a lead's worker started inside its coordinator's run nests under the lead, which stays at work", async () => {
  const { finishedAgents } = await import('./view.ts')
  // As `orca worktree ps` reports it: the worker's parent is the lead, the lead's is the coordinator.
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'isola', repo: 'isola', path: '/c/isola', liveTerminalCount: 1, agents: [{ paneKey: 'p-home', state: 'done' }] },
    { identity: { key: 'env' }, displayName: 'env-cleanup', repo: 'isola', path: '/w/env', liveTerminalCount: 2, agents: [
      { paneKey: 'p-worker', parentPaneKey: 'p-lead', state: 'working' },
      { paneKey: 'p-lead', parentPaneKey: 'p-home', state: 'done' }
    ] }
  ])
  const coordinators = [{ key: 'isola', name: 'isola', repos: ['isola'], about: '', dir: '/c/isola', workspaceId: null }]
  // Both dispatches live in the coordinator's run, so the run alone credits both to the coordinator.
  const lineage = {
    dispatcherOf: new Map([['p-lead', 'term-home'], ['p-worker', 'term-home']]),
    paneOf: new Map([['term-home', 'p-home'], ['term-lead', 'p-lead'], ['term-worker', 'p-worker']]),
    dispatchOf: new Map([['p-lead', 'open' as const], ['p-worker', 'open' as const]])
  }
  const [, env] = assignCoordinators(rows, coordinators, lineage)
  const byPane = Object.fromEntries(env.agents.map((a) => [a.paneKey, [a.coordinator, a.leadPane]]))
  assert.deepEqual(byPane, { 'p-worker': ['isola', 'p-lead'], 'p-lead': ['isola', null] })
  assert.deepEqual(finishedAgents([env]).map((a) => a.paneKey), [], 'the lead leads a working worker')
  // An agent without a parent pane still falls back to the run lineage.
  const noParent = main.fromPs([
    { identity: { key: 'home' }, displayName: 'isola', repo: 'isola', path: '/c/isola', agents: [{ paneKey: 'p-home', state: 'done' }] },
    { identity: { key: 'x' }, displayName: 'x', repo: 'isola', agents: [{ paneKey: 'p-worker', state: 'working' }] }
  ])
  assert.deepEqual(assignCoordinators(noParent, coordinators, lineage)[1].agents.map((a) => [a.coordinator, a.leadPane, a.dispatch]), [['isola', null, 'open']])
})

test('your coordinators are folders under the coordinator home; new ones are validated and scaffolded', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'coordinators-'))
  scaffoldCoordinator(root, { name: 'main', look: null })
  scaffoldCoordinator(root, { name: 'alpha', look: { color: '#5b8def', shape: 'hex' } })
  assert.deepEqual(readCoordinators(root).map((c) => [c.name, c.repos, c.look?.shape ?? null]), [['alpha', [], 'hex'], ['main', [], null]])
  assert.match(readFileSync(join(root, 'alpha', 'CLAUDE.md'), 'utf8'), new RegExp(`scope is not set yet[\\s\\S]*${COORDINATOR_FILE}`))
  assert.equal(validateName('alpha', ['alpha']), 'alpha already exists')
  assert.equal(validateName('Bad Name', []), 'Use lowercase letters, digits and dashes')
  assert.equal(validateName('ops-2', []), null)
})

test('cockpit stats: heaviest by memory, finished sessions with their terminals', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'a', repo: 'shop', agents: [{ paneKey: 'p1', state: 'working', conversationName: 'Busy' }] },
    { identity: { key: 'b' }, displayName: 'b', repo: 'shop', agents: [{ paneKey: 'p2', state: 'done', conversationName: 'Idle one' }] }
  ])
  const stats = buildCockpit(
    rows,
    { sessions: [{ paneKey: 'p1', bytes: 1.5 * 1024 ** 3 }, { paneKey: 'p2', bytes: 400 * 1024 ** 2 }], host: { totalBytes: 16 * 1024 ** 3, usedBytes: 8.1 * 1024 ** 3 } },
    new Map([['p1', 'term-1'], ['p2', 'term-2']]),
    [],
    { usedGB: 20, totalGB: 21 },
    [{ key: '/w/b|p2', path: '/w/b', paneKey: 'p2', workspaceId: 'b', worktreeName: 'b', repo: 'shop', name: 'next-server', count: 3, memMB: 1400 }]
  )
  // The idle session started a 1.4 GB dev server, so in all it outweighs the busy one.
  assert.deepEqual(stats.heaviest.map((h) => [h.title, h.memMB]), [['Idle one', 400], ['Busy', 1536]])
  assert.deepEqual(stats.ram, { usedGB: 8.1, totalGB: 16 })
  assert.deepEqual(stats.finished.map((f) => f.terminal), ['term-2'])
})

test('remove refuses what it cannot verify, before running any command', async () => {
  const [row] = main.fromPs([{ identity: { key: 'gone' }, displayName: 'gone', repo: 'shop', agents: [] }])
  assert.deepEqual(await removeWorktree(async () => ({}), row), { removed: false, reason: 'main checkout' })
  assert.deepEqual(await removeWorktree(async () => ({}), undefined), { removed: false, reason: 'workspace not found' })
})

test('Orca\'s monitoring mode is carried through', () => {
  const [row] = main.fromPs([{ identity: { key: 'v' }, displayName: 'main', repo: 'shop', agents: [{ paneKey: 'p', state: 'working', workingMode: 'monitoring' }] }])
  assert.equal(row.agents[0].workingMode, 'monitoring')
})

test('folder workspaces without an identity key are kept, with the id the plugin API lists', () => {
  const rows = main.fromPs(
    [{ worktreeId: 'r::/c/alpha', path: '/c/alpha', displayName: 'alpha', repo: 'alpha', liveTerminalCount: 3, agents: [{ paneKey: 'p', state: 'done' }] }],
    undefined,
    new Map([['/c/alpha', 'folder:abc']])
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'folder:abc')
  assert.equal(main.fromPs([{ worktreeId: 'r::/x', path: '/x', displayName: 'x', agents: [] }]).length, 0, 'no id at all: skipped')
})

test('the pending question comes from Orca\'s toolInput', () => {
  assert.equal(main.questionOf({ state: 'waiting', toolName: 'AskUserQuestion', toolInput: JSON.stringify({ questions: [{ question: 'Pick one?' }] }) }), 'Pick one?')
  assert.equal(main.questionOf({ state: 'working', toolName: 'AskUserQuestion', toolInput: '{}' }), null)
  assert.equal(main.questionOf({ state: 'waiting', toolName: 'Bash', toolInput: 'ls' }), null)
})

test('a new look keeps the rest of the coordinator file; delete only removes a coordinator folder', async () => {
  const { mkdtempSync, existsSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'coords-'))
  const dir = scaffoldCoordinator(root, { name: 'ops', look: null })
  writeLook(dir, { color: '#4fbfc8', shape: 'shield' })
  const [ops] = readCoordinators(root)
  assert.deepEqual([ops.name, ops.look], ['ops', { color: '#4fbfc8', shape: 'shield' }])
  assert.throws(() => deleteFolder(root, root), /refusing/)
  mkdirSync(join(root, 'stray'))
  assert.throws(() => deleteFolder(join(root, 'stray'), root), /refusing/) // no coordinator file: not ours
  deleteFolder(dir, root)
  assert.equal(existsSync(dir), false)
})

test('waking a coordinator adds --continue only to the launch the plugin marked', () => {
  const pending = new Set(['ws-1'])
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-2', command: 'claude' }, pending), null, 'other launches untouched')
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-1', command: 'claude --plugin-dir x' }, pending), 'claude --plugin-dir x --continue')
  assert.equal(main.resumeCommand({ agent: 'claude', workspaceId: 'ws-1', command: 'claude' }, pending), null, 'a mark is used once')
})

test('a folder has history when Claude kept a transcript for it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'projects-'))
  mkdirSync(join(root, '-c-alpha'))
  writeFileSync(join(root, '-c-alpha', 'abc.jsonl'), '{}')
  assert.equal(main.hasHistory('/c/alpha', [root]), true)
  assert.equal(main.hasHistory('/c/main', [root]), false)
})

test('a coordinator is live while its workspace has an open terminal with an agent', () => {
  const rows = main.fromPs(
    [
      { worktreeId: 'a::/c/fv', path: '/c/fv', displayName: 'fv', liveTerminalCount: 1, agents: [{ paneKey: 'p', state: 'done' }] },
      { worktreeId: 'b::/c/mk', path: '/c/mk', displayName: 'mk', liveTerminalCount: 0, agents: [{ paneKey: 'q', state: 'done' }] }
    ],
    undefined,
    new Map([['/c/fv', 'ws-fv'], ['/c/mk', 'ws-mk']])
  )
  assert.equal(main.isLive('/c/fv', rows), true, 'open terminal: just open it')
  assert.equal(main.isLive('/c/mk', rows), false, 'no open terminal: wake it')
  assert.equal(main.isLive('/c/none', rows), false)
})

test('coordinator homes are never finished work', () => {
  const rows = main.fromPs(
    [
      { worktreeId: 'a::/code/shop', path: '/code/shop', displayName: 'main', repo: 'shop', liveTerminalCount: 1, agents: [{ paneKey: 'p1', state: 'working' }] },
      { worktreeId: 'b::/c/alpha', path: '/c/alpha', displayName: 'alpha', liveTerminalCount: 1, agents: [{ paneKey: 'p2', state: 'done' }] },
      { worktreeId: 'c::/c/main', path: '/c/main', displayName: 'main', liveTerminalCount: 1, agents: [{ paneKey: 'p3', state: 'done' }] }
    ],
    undefined,
    new Map([['/code/shop', 'w1'], ['/c/alpha', 'w2'], ['/c/main', 'w3']])
  )
  const c = main.capacityOf(rows, 'normal', undefined, '/nonexistent', (p) => Boolean(p?.startsWith('/c/')))
  assert.equal(c.finishedOpen, 0)
})

test('a coordinator home is any folder under the home or one with a coordinator file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const elsewhere = mkdtempSync(join(tmpdir(), 'home-'))
  writeFileSync(join(elsewhere, COORDINATOR_FILE), '{}')
  assert.equal(isCoordinatorHome('/h/coordinators/alpha', '/h/coordinators'), true)
  assert.equal(isCoordinatorHome(elsewhere, '/h/coordinators'), true)
  assert.equal(isCoordinatorHome('/code/shop', '/h/coordinators'), false)
  assert.equal(isCoordinatorHome(null, '/h/coordinators'), false)
})

test("transcripts come from Orca's SQLite hook store, newest entry per pane, else the old JSON file", async () => {
  const { findTranscript, transcriptOf } = await import('./summarize.ts')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
  const t = (name: string) => (writeFileSync(join(dir, name), ''), join(dir, name))
  const [current, older, legacy] = [t('current.jsonl'), t('older.jsonl'), t('legacy.jsonl')]
  const files = { db: join(dir, 'last-status.db'), json: join(dir, 'last-status.json') }

  // A fixture shaped like Orca's agent-hooks/last-status.db (schema_version 202), written in WAL mode.
  const { DatabaseSync } = process.getBuiltinModule!('node:sqlite')
  const db = new DatabaseSync(files.db)
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rows(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '202');`)
  const put = db.prepare('INSERT INTO rows VALUES (?, ?, ?)')
  const entry = (pane: string, transcriptPath: string) => JSON.stringify({ paneKey: pane, source: 'claude', hookEventName: 'Stop', providerSession: { transcriptPath } })
  put.run('entry\0tab-a:leaf-1', 42, entry('tab-a:leaf-1', current))
  put.run('entry', 7, entry('tab-a:leaf-1', older))
  put.run('commitment\0tab-a:leaf-1', 159, JSON.stringify({ paneKey: 'tab-a:leaf-1', launchTokenHash: 'x' }))
  put.run('entry\0tab-b:leaf-2', 43, entry('tab-b:leaf-2', '/missing.jsonl'))
  put.run('commitment\0tab-c:leaf-3', 160, JSON.stringify({ paneKey: 'tab-c:leaf-3' }))

  // Read while Orca still holds the database open for writing.
  assert.equal(transcriptOf('tab-a:leaf-1', files), current, 'the newest entry row by seq')
  assert.equal(transcriptOf('tab-b:leaf-2', files), null, 'a transcript that is gone')
  const commitmentOnly = findTranscript('tab-c:leaf-3', files)
  assert.equal(commitmentOnly.path, null, 'a commitment row has no transcript')
  assert.match(commitmentOnly.path === null ? commitmentOnly.why : '', /last-status\.db has no entry for the pane; .*last-status\.json does not exist/)
  db.close()

  writeFileSync(files.json, JSON.stringify({ entries: { 'tab-d:leaf-4': { providerSession: { transcriptPath: legacy } } } }))
  assert.equal(transcriptOf('tab-d:leaf-4', files), legacy, 'older Orca: the JSON file')
  assert.equal(transcriptOf('tab-d:leaf-4', { db: join(dir, 'none.db'), json: files.json }), legacy, 'no database at all')
})

test("a coordinator's card does not repeat its lead's question; a lead's still asks", async () => {
  const { COORDINATOR_ASKS, digest, promptFor } = await import('./summarize.ts')
  const line = (type: string, content: unknown) => JSON.stringify({ type, timestamp: '2026-11-16T12:00:00Z', message: { content } })
  const relay = 'The plugin lead is staying open: try 0.2.4 in the sidebar and tell it if anything is off.'
  const coordinator = digest([
    line('user', 'Fix the sidebar summaries'),
    line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'orca orchestration worker-start --worktree path:/w --agent claude' } }]),
    line('user', 'status from the lead'),
    line('assistant', [{ type: 'text', text: relay }])
  ])!
  assert.equal(coordinator.role, 'coordinator')
  const prompt = promptFor(coordinator, { title: 'Orca Flow fixes' })
  assert.ok(prompt.startsWith(COORDINATOR_ASKS), 'the coordinator rule comes first')
  assert.match(COORDINATOR_ASKS, /relays[\s\S]*NOT its ask: set needs\.type "none"/)
  assert.match(prompt, /AGENT'S FINAL MESSAGE THIS TURN:\nThe plugin lead is staying open/)
  const lead = digest([line('user', 'Your role: lead. Fix the summaries'), line('assistant', [{ type: 'text', text: 'Does 0.2.4 look right?' }])])!
  assert.equal(lead.role, 'lead')
  assert.ok(!promptFor(lead, null).includes(COORDINATOR_ASKS), 'a lead keeps its own asks')
})

test('turns are summarized once per burst, one run per pane, newest job after a running one', async () => {
  const { turnSummarizer } = await import('./summarize.ts')
  const runs: string[] = []
  const logs: string[] = []
  let release = () => {}
  const s = turnSummarizer({
    delayMs: 5,
    log: (m) => logs.push(m),
    findTranscript: (pane) => (pane.startsWith('none') ? { path: null, why: 'no entry' } : { path: `/t/${pane}` }),
    run: (job) => {
      runs.push(`${job.pane}@${job.worktreeId}`)
      return new Promise<void>((r) => (release = r))
    }
  })
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'working' })
  s.onStatus({ paneKey: 'none', workspaceId: null, state: 'done' })
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'waiting' })
  s.onStatus({ paneKey: 'p1', workspaceId: 'w1', state: 'done' })
  await wait(20)
  assert.deepEqual(runs, ['p1@w1'])
  s.onStatus({ paneKey: 'p1', workspaceId: 'w2', state: 'done' })
  await wait(20)
  assert.deepEqual(runs, ['p1@w1'])
  release()
  await wait(5)
  assert.deepEqual(runs, ['p1@w1', 'p1@w2'])
  s.onStatus({ paneKey: 'none-2', workspaceId: null, state: 'done' })
  await wait(20)
  assert.equal(logs.length, 1, 'a missing transcript is logged once, not every turn')
  assert.match(logs[0], /SUMMARIES OFF: no Claude transcript found for pane none\b.*no entry/)
  release()
  s.dispose()
})

test('setup links the CLI, skill and coordinator CLAUDE.md, repoints old links, keeps real files', async () => {
  const { ensureLinks } = await import('./install.ts')
  const { mkdtempSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'links-'))
  mkdirSync(join(t, 'bin'))
  symlinkSync('/old/install/bin/tool.mjs', join(t, 'bin', 'tool'))
  writeFileSync(join(t, 'CLAUDE.md'), 'mine')
  const links = [
    { from: join(t, 'bin', 'tool'), to: '/new/bin/tool.mjs' },
    { from: join(t, 'skills', 'orca-flow'), to: '/new/skills/orca-flow' },
    { from: join(t, 'CLAUDE.md'), to: '/new/templates/CLAUDE.md' }
  ]
  const log = ensureLinks(links)
  assert.equal(readlinkSync(join(t, 'bin', 'tool')), '/new/bin/tool.mjs')
  assert.equal(readlinkSync(join(t, 'skills', 'orca-flow')), '/new/skills/orca-flow')
  assert.equal(readFileSync(join(t, 'CLAUDE.md'), 'utf8'), 'mine')
  assert.equal(log.length, 3)
  assert.deepEqual(ensureLinks(links), [`kept ${join(t, 'CLAUDE.md')}: not a link`])
})

test('a coordinator keeps its workers while it sleeps: its closed terminal ran in its folder', async () => {
  const { dirOfTerminalRecord, loadLineage } = await import('./coordinators.ts')
  const coordinators = [{ key: 'alpha', name: 'alpha', repos: [], about: '', dir: '/c/alpha', workspaceId: null }]
  const rows = main.fromPs([
    { identity: { key: 'home' }, displayName: 'alpha', repo: 'alpha', path: '/c/alpha', agents: [] },
    { identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', agents: [{ paneKey: 'p:worker', state: 'working' }] }
  ])
  // Orca's CLI: one run coordinated from the old, closed terminal; a second run with no live workers.
  const calls: string[] = []
  const run = async (args: string[]) => {
    calls.push(args.slice(0, 2).join(' '))
    if (args[0] === 'terminal' && args[1] === 'list') return { terminals: [{ handle: 'term-worker', tabId: 'p', leafId: 'worker' }] }
    if (args[1] === 'run-list') return { runs: [{ id: 'run-a', coordinator_handle: 'term-old' }, { id: 'run-b', coordinator_handle: 'term-x' }, { id: 'run_unbound', coordinator_handle: null }] }
    if (args[1] === 'worker-list') return { workers: args[3] === 'run-a' ? [{ terminal: 'term-worker', terminalState: 'retained', taskId: 't1' }] : [{ terminal: 'term-gone', terminalState: 'released' }] }
    if (args[0] === 'terminal' && args[1] === 'show') return { terminal: { worktreeId: 'repo1::/c/alpha', worktreePath: '' } }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  const lineage = await loadLineage(run, 1_000_000)
  assert.equal(calls.filter((c) => c === 'terminal show').length, 1)
  const worker = assignCoordinators(rows, coordinators, lineage)[1].agents[0]
  assert.equal(worker.coordinator, 'alpha')
  assert.equal(dirOfTerminalRecord({ worktreePath: '/a', worktreeId: 'r::/b' }), '/a')
  assert.equal(dirOfTerminalRecord(null), null)
})

test('processes an agent started outside its session are found by the tags they inherit', async () => {
  const { parsePs, parseTop, startedGroups } = await import('./started.ts')
  const tag = (pane: string) => `ORCA_WORKTREE_ID=repo1::/w/checkout ORCA_PANE_KEY=${pane} HOME=/h`
  const ps = [
    `  100     1 /usr/bin/login -flpq me ${tag('p1')}`,
    `  101   100 -/bin/zsh -l ${tag('p1')}`,
    `  102   101 claude --continue ${tag('p1')}`,
    `  200     1 node /h/.nvm/bin/pnpm dev ${tag('p1')}`,
    `  201   200 node /w/checkout/node_modules/.bin/next dev --turbopack ${tag('p1')}`,
    '  202   201 next-server (v16.4.5)',
    `  300     1 node /w/other/server.js ORCA_WORKTREE_ID=repo1::/w/unknown ORCA_PANE_KEY=p9`,
    `  400     1 python3 - echo ORCA_WORKTREE_ID=(x) looks like a tag`,
    '  500     1 /usr/sbin/cfprefsd agent'
  ].join('\n')
  const procs = parsePs(ps)
  assert.deepEqual(procs.find((p) => p.pid === 201), { pid: 201, ppid: 200, name: 'next', worktree: '/w/checkout', pane: 'p1' })
  const top = parseTop('PID    MEM\n202    972M+\n201    42M\n200    40M-\n102    300M\n')
  assert.equal(top.get(202), 972 * 1024 ** 2)
  const rows = main.fromPs([{ identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', path: '/w/checkout', agents: [{ paneKey: 'p1', state: 'working' }] }])
  // Orca counts the session (login -> zsh -> claude); the detached pnpm tree is what it misses.
  const groups = startedGroups(procs, top, [100], rows)
  assert.deepEqual(groups.map((g) => [g.key, g.name, g.count, g.memMB]), [['/w/checkout|p1', 'next-server', 3, 1054]])
})

test('capacity is one memory budget: free memory after the margin against what a start costs', async () => {
  const { costsOf, decide, DEFAULT_CONFIG, diskFreeOf, envCost } = await import('./capacity.ts')
  assert.equal(diskFreeOf('Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5   482797652 409147004  32401648    93%    /System/Volumes/Data\n'), 30.9)
  assert.equal(diskFreeOf(''), null)
  // Agent sessions: shells with no agent (a few MB) do not count; a project's environment is what its worktrees started.
  const costs = costsOf([0.012, 0.32, 0.39, 0.53, 1.9], [{ repo: 'shop', gb: 2.6 }, { repo: 'shop', gb: 1.8 }, { repo: 'docs', gb: 0 }])
  assert.deepEqual(costs, { agentGB: 0.5, envGB: { 'shop': 2.2 } })
  assert.equal(envCost(costs.envGB, 'docs'), 1.5, 'a project never seen running servers is priced at the fallback')
  const at = (availableGB: number | null, pressure: 'normal' | 'warn' | 'critical' = 'normal') =>
    decide({ availableGB, pressure, config: DEFAULT_CONFIG, agentGB: 0.5, envGB: 2.2 })
  assert.deepEqual(at(6), { verdict: 'ok', freeGB: 4 })
  assert.deepEqual(at(4), { verdict: 'agents-only', freeGB: 2 })
  assert.deepEqual(at(2.3), { verdict: 'full', freeGB: 0.3 })
  assert.equal(at(9, 'warn').verdict, 'agents-only', 'pressure warn: no new environments')
  assert.equal(at(9, 'critical').verdict, 'pressure')
  assert.deepEqual(at(null), { verdict: 'ok', freeGB: null }, 'before Orca reports memory, nothing is blocked on a guess')
})

test('a worker keeps the title of what it is doing, not the last task it was handed', () => {
  // Orca: conversation "Guest checkout with saved cards", last dispatched task "Settings page (3 UI fixes)".
  const ps = (summary: boolean) => main.fromPs([{ identity: { key: 'w' }, displayName: 'checkout', repo: 'shop', agents: [
    { paneKey: 'p1', state: 'working', conversationName: 'Guest checkout with saved cards', taskTitle: 'Settings page (3 UI fixes)' }
  ] }], summary ? { cards: {}, summaries: { p1: { title: 'Guest checkout' } as never } } : { cards: {}, summaries: {} })
  const lineage = { dispatcherOf: new Map([['p1', 'term-c']]), paneOf: new Map() }
  assert.equal(assignCoordinators(ps(true), [], lineage)[0].agents[0].title, 'Guest checkout')
  assert.equal(assignCoordinators(ps(false), [], lineage)[0].agents[0].title, 'Guest checkout with saved cards')
})

test('the coordinator CLAUDE.md is copied once, replaces an old link, then stays the user\'s', async () => {
  const { ensureSeeds } = await import('./install.ts')
  const { mkdtempSync, readFileSync, symlinkSync, writeFileSync, lstatSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const t = mkdtempSync(join(tmpdir(), 'seed-'))
  writeFileSync(join(t, 'template.md'), 'template')
  const seed = [{ from: join(t, 'home', 'CLAUDE.md'), to: join(t, 'template.md') }]
  assert.deepEqual(ensureSeeds(seed), [`wrote ${join(t, 'home', 'CLAUDE.md')}`])
  writeFileSync(join(t, 'home', 'CLAUDE.md'), 'template\n- my notes')
  assert.deepEqual(ensureSeeds(seed), [], 'a file the user has is never overwritten')
  assert.equal(readFileSync(join(t, 'home', 'CLAUDE.md'), 'utf8'), 'template\n- my notes')
  const old = [{ from: join(t, 'linked.md'), to: join(t, 'template.md') }]
  symlinkSync(join(t, 'template.md'), join(t, 'linked.md'))
  ensureSeeds(old)
  assert.equal(lstatSync(join(t, 'linked.md')).isSymbolicLink(), false, 'an old link becomes a real copy')
})

test('a worker named after its task id shows its task title instead', () => {
  const [row] = main.fromPs([{ identity: { key: 'w' }, displayName: 'onboarding', repo: 'shop', agents: [
    { paneKey: 'p', state: 'working', conversationName: 'worker-task_77145d6691b3', taskTitle: 'Review PR #1770' }
  ] }])
  assert.equal(row.agents[0].title, 'Review PR #1770')
})

test('focus moves at once from the workspace.changed event, by terminal or by name and branch', () => {
  const rows = main.fromPs([
    { identity: { key: 'a' }, displayName: 'checkout', repo: 'shop', branch: 'refs/heads/checkout', isActive: true, agents: [{ paneKey: 'pa', state: 'working' }] },
    { identity: { key: 'b' }, displayName: 'search', repo: 'shop', branch: 'refs/heads/search', agents: [{ paneKey: 'pb', state: 'working' }] }
  ]).map((r) => ({ ...r, agents: r.agents.map((a) => ({ ...a, terminal: a.paneKey === 'pb' ? 'term-b' : null })) }))
  const snap = { rows, source: 'cli' as const, capacity: null, coordinators: [{ key: 'alpha', name: 'alpha', repos: [], workspaceId: 'w', session: null }] }
  const byTerminal = main.withFocus(snap, { branch: 'x', displayName: 'x', terminals: [{ id: 'term-b' }] })
  assert.deepEqual(byTerminal.rows.map((r) => r.active), [false, true])
  const byName = main.withFocus(snap, { branch: 'checkout', displayName: 'checkout', terminals: [] })
  assert.deepEqual(byName.rows.map((r) => r.active), [true, false])
  const coordinator = main.withFocus(snap, { branch: '', displayName: 'alpha', terminals: [] })
  assert.deepEqual([coordinator.rows.some((r) => r.active), coordinator.coordinators[0].active], [false, true])
})

test('remove anyway waives uncommitted files only, after the person confirmed', async () => {
  const { removeWorktree } = await import('./cockpit.ts')
  const calls: string[][] = []
  const run = async (args: string[]) => { calls.push(args); return {} }
  // A main checkout is refused whatever force says, before any command runs.
  const main_ = main.fromPs([{ identity: { key: 'm' }, displayName: 'main', repo: 'shop', isMainWorktree: true, agents: [] }])[0]
  assert.deepEqual(await removeWorktree(run, main_, true), { removed: false, reason: 'main checkout' })
  assert.equal(calls.length, 0)
})
