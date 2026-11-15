// The panel's HTML from a snapshot, checked in Node.
import { assert, test } from 'orca/testing'
import type { AgentInfo, AgentSummary, Snapshot, WorkspaceRow } from './protocol.ts'
import { character, emptyUi, faceOf, finishedAgents, freeLooks, gaugesOf, prBadge, render } from './view.ts'
import type { CockpitStats } from './protocol.ts'

const noMatch = (text: string, re: RegExp, message?: string) => assert.ok(!re.test(text), message ?? `unexpected ${re}`)

const summary = (over: Partial<AgentSummary> = {}): AgentSummary => ({
  title: 'Work', about: 'What this is for.', glance: '', goal: '', since: 'Did a thing',
  needs: { type: 'none', ask: '', options: [] }, effort: 'quick', priority: 'P2', role: 'solo', updatedAt: 1, ...over
})
const agent = (paneKey: string, title: string, state: AgentInfo['state'], over: Partial<AgentInfo> = {}): AgentInfo => ({
  paneKey, title, state, agentType: 'claude', summary: null, workingMode: null, coordinator: 'you', leadPane: null, terminal: null, question: null, ...over
})
const row = (id: string, repo: string, agents: AgentInfo[], over: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  id, name: id, branch: id, repo, path: `/w/${id}`, main: false, agents, state: agents[0]?.state ?? null, priority: null, card: null, parentId: null,
  liveTerminals: agents.length ? 1 : 0, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: 0, createdAt: 0, pr: null, ...over
})

const asks = (glance: string, priority: 'P1' | 'P2' = 'P1') =>
  summary({ title: glance, priority, glance, about: `About ${glance}.`, needs: { type: 'decision', ask: `${glance} long form`, options: [] } })

const snap: Snapshot = {
  source: 'cli',
  capacity: { verdict: 'agents-only', freeGB: 1.6, marginGB: 2, diskFreeGB: 18, agentGB: 0.5, envGB: 2.6, pressure: 'normal', finishedOpen: 1 },
  coordinators: [{ key: 'alpha', name: 'alpha', repos: ['shop'], workspaceId: 'ws-fv' }, { key: 'main', name: 'main', repos: [], workspaceId: null }],
  rows: [
    row('coord', 'shop', [agent('p-coord', 'Checkout bug', 'working', { coordinator: 'alpha' })], { priority: 'P1' }),
    row('dup', 'shop', [agent('p-dup', 'Duplicate accounts', 'done', { coordinator: 'alpha', leadPane: 'p-coord', summary: asks('Merge accounts by email?') })], { priority: 'P1' }),
    row('hook', 'blog', [agent('p-hook', 'Launch post headline', 'done', { coordinator: 'main', summary: asks('Pick a headline', 'P2') })], { priority: 'P2' }),
    row('pricing', 'shop', [agent('p-pricing', 'Pricing page', 'working')]),
    row('cleanup', 'shop', [agent('p-cleanup', 'State cleanup', 'done', { summary: summary({ since: 'PR #1753 merged' }) })]),
    row('quiet', 'video', [])
  ]
}

test('up next: the first briefing is open with about, the glance and one jump; the rest are one line', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /Up next · 2/)
  const brief = main.slice(main.indexOf('class="brief"'), main.indexOf('</div><button class="item"', main.indexOf('class="brief"')) + 1)
  assert.match(brief, /About Merge accounts by email\?\./)
  assert.match(brief, /Asks · decision/)
  assert.match(brief, /Merge accounts by email\?/)
  assert.equal((brief.match(/data-open=/g) ?? []).length, 1, 'the only action is Jump to session')
  noMatch(main, /⌘⇧N/, 'no keyboard shortcut shown')
  noMatch(main, /data-tip="Pick a headline"/, 'rows have no long tooltips')
})

test('closing the first and opening another follows the person', () => {
  const ui = emptyUi()
  ui.closed.add('p-dup')
  ui.opened.add('p-hook')
  const { main } = render(snap, ui)
  assert.match(main, /About Pick a headline/)
  noMatch(main, /About Merge accounts by email/)
})

test('coordinators: a single-project coordinator is its project; multi-repo groups label projects softly', () => {
  const { main } = render(snap, emptyUi())
  const tree = main.slice(main.indexOf('class="tree"'))
  const first = tree.indexOf('<section class="coordinator">')
  const alpha = tree.slice(first, tree.indexOf('<section class="coordinator">', first + 1))
  assert.match(alpha, /alpha/)
  assert.match(alpha, /class="item indent"/, 'the worker nests under its coordinator')
  noMatch(alpha, /class="soft"/)
  assert.match(tree, /Launch post headline[\s\S]*?<span class="soft">blog<\/span>/)
  assert.match(tree, /chats you started/)
})

test('characters carry state; no status dots', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /class="spin"/, 'working characters carry a spinner badge')
  noMatch(main, /class="dot/, 'no status dots')
  assert.equal(faceOf(agent('x', 'x', 'blocked')), 'asks')
  assert.equal(faceOf(agent('x', 'x', 'done', { summary: summary() })), 'done')
})

test('finished and idle live in the footer, folded until opened', () => {
  const ui = emptyUi()
  assert.match(render(snap, ui).footer, /Finished · 1/)
  noMatch(render(snap, ui).main, /Finished ·/, 'not in the scrolling middle')
  noMatch(render(snap, ui).footer, /State cleanup/)
  ui.unfolded.add('finished')
  assert.match(render(snap, ui).footer, /class="group fold-list"[\s\S]*State cleanup/)
  assert.match(render(snap, ui).footer, /Idle · 1/)
})

test('cockpit flags only what is over and explains on demand; search replaces the lists', () => {
  assert.deepEqual(gaugesOf(snap.capacity!).map((g) => [g.key, g.icon, g.text, g.tone]), [['memory', 'chip', '1.6 GB free', 'warn'], ['disk', 'disk', '18 GB free', 'warn'], ['idle', 'pause', '1', '']])
  const ui = emptyUi()
  assert.match(render(snap, ui).cockpit, /data-tip="Room for agents, not environments" data-tone="warn"/)
  const roomy = { ...snap.capacity!, verdict: 'ok' as const, freeGB: 6.1 }
  assert.deepEqual(gaugesOf(roomy)[0], { key: 'memory', icon: 'chip', text: '6.1 GB free', tone: '', tip: 'Memory, after 2 GB margin' })
  assert.deepEqual(gaugesOf({ ...roomy, diskFreeGB: 212.4 })[1].text, '212 GB free')
  assert.deepEqual(gaugesOf({ ...roomy, freeGB: null, diskFreeGB: null }).map((g) => g.key), ['idle'], 'no number before it is measured')
  for (const g of gaugesOf(snap.capacity!)) assert.ok(g.tip.split(' ').length <= 5, `"${g.tip}" is over five words`)
  ui.query = 'headline'
  const { main } = render(snap, ui)
  assert.match(main, /Launch post headline/)
  noMatch(main, /Up next/)
})

test('old summaries cannot claim an ask, and leaked ids are never shown', () => {
  const old = { ...summary({ needs: { type: 'review', ask: 'Agent is running in term_2cab2e54-96b7. Check it?', options: [] } }) } as AgentSummary
  delete (old as { glance?: string }).glance
  const s2: Snapshot = { ...snap, rows: [row('x', 'shop', [agent('p-x', 'Fix bug', 'done', { summary: old })])] }
  const { main } = render(s2, emptyUi())
  noMatch(main, /Up next/, 'an old-format summary does not put anything in Up next')
  noMatch(main, /term_2cab/)
})

test('blocked always asks; a summary cannot hide Orca\'s waiting', () => {
  const calm = summary({ glance: 'Wait for E2E results', needs: { type: 'none', ask: '', options: [] } })
  const s3: Snapshot = { ...snap, rows: [
    row('w', 'shop', [agent('p-w', 'Live preview', 'waiting', { summary: calm })]),
    row('b', 'shop', [agent('p-b', 'Permission', 'blocked', { summary: calm })])
  ] }
  const { main } = render(s3, emptyUi())
  assert.match(main, /Up next · 2/, 'both count: Orca says both wait on you')
  assert.match(main, /Approve a permission prompt|Answer its question/)
  noMatch(main, /Wait for E2E results/)
})

test('once you answer and the agent works again, it leaves Up next', () => {
  const answered = agent('p-dup', 'Duplicate accounts', 'working', { summary: asks('Merge accounts by email?') })
  const s4: Snapshot = { ...snap, rows: [row('dup', 'shop', [answered])] }
  const { main } = render(s4, emptyUi())
  noMatch(main, /Up next/)
  assert.match(main, /class="spin"/, 'it shows as working in the tree')
})

test('monitoring comes from Orca: its working mode, even while its state says working', () => {
  const watching = agent('p-m', 'Valuation', 'working', { workingMode: 'monitoring' })
  const done = agent('p-d', 'Cleanup', 'done', { summary: summary({ watching: 'E2E run' }) })
  assert.equal(faceOf(watching), 'monitoring')
  assert.equal(faceOf(done), 'done', 'our own summary does not override Orca')
  const s5: Snapshot = { ...snap, rows: [row('m', 'shop', [watching])] }
  const { main } = render(s5, emptyUi())
  assert.match(main, /class="spin slow"/)
  noMatch(main, /Up next/)
})

test('the opened cockpit: memory, heaviest, counts and actions that confirm in place', () => {
  const stats: CockpitStats = {
    swap: { usedGB: 20.1, totalGB: 21 }, ram: { usedGB: 15.1, totalGB: 16 },
    started: [
      { key: '/w/pricing|p-pricing', path: '/w/pricing', paneKey: 'p-pricing', workspaceId: 'pricing', worktreeName: 'pricing', repo: 'shop', name: 'next-server', count: 4, memMB: 1300 },
      { key: '/w/old|p-gone', path: '/w/old', paneKey: 'p-gone', workspaceId: 'old', worktreeName: 'old-feature', repo: 'shop', name: 'vite', count: 1, memMB: 300 }
    ],
    heaviest: [{ paneKey: 'p-pricing', terminal: 'term-pricing', workspaceId: 'pricing', title: 'Pricing page', repo: 'shop', memMB: 1500 }],
    finished: [{ paneKey: 'p-cleanup', terminal: 'term-cleanup', workspaceId: 'cleanup', title: 'State cleanup', repo: 'shop', memMB: 430 }],
    merged: [{ workspaceId: 'cleanup', name: 'state-cleanup', repo: 'shop', pr: 1753 }]
  }
  const ui = emptyUi()
  assert.match(render(snap, ui).cockpit, /aria-expanded="false"/)
  noMatch(render(snap, ui).copen, /class="copen"/)
  ui.cockpitOpen = true
  assert.match(render(snap, ui).copen, /class="copen"><div class="loader" aria-busy="true"[\s\S]*class="hop"[\s\S]*Checking what’s running…/, 'first open shows the hopping crew')
  ui.stats = stats
  ui.statsLoading = true
  assert.match(render(snap, ui).copen, /class="refreshing"/, 'reopening keeps the last stats with a spinner')
  ui.statsLoading = false
  const open = render(snap, ui).copen
  assert.match(open, /meter-label">Swap<\/span><span class="bar warn">[\s\S]*?20\.1 of 21 GB/)
  assert.match(open, /class="warn">15\.1 of 16 GB used/, 'RAM shows total and used, warning when nearly full')
  noMatch(open, /By process|after the 2 GB margin/)
  assert.match(open, /Pricing page[\s\S]*?class="item static started"><span class="sub-mark">↳<\/span><span class="t">next-server \+3<\/span><span class="r">1\.3 GB<\/span><\/div>/, 'what a session started sits under it')
  assert.match(open, /vite <span class="soft">old-feature<\/span><\/span><span class="r">300 MB/, 'what a sleeping agent left running is listed with its worktree')
  assert.match(open, /Pricing page[\s\S]*1\.5 GB[\s\S]*data-yes="close:p-pricing">sleep/)
  noMatch(open, /data-act="closeall"/, 'closing finished sessions lives in the footer now')
  assert.match(open, /class="stat ask"><span class="n">2<\/span><span class="l">asking/)
  assert.match(open, /<button class="stat more" data-show-finished><span class="n">1<\/span>/)
  assert.match(open, /Remove state-cleanup[\s\S]*PR #1753 merged · clean/)
  ui.pending = 'remove:cleanup'
  assert.match(render(snap, ui).copen, /class="pending"><span class="refreshing"><\/span>Removing…/)
  ui.pending = null
  ui.notice = { key: 'remove:cleanup', text: 'Removed', ok: true }
  assert.match(render(snap, ui).copen, /class="notice ok">Removed/)
})

test('the footer\'s finished list closes one by one or all at once, confirming in place', () => {
  const two: Snapshot = { ...snap, rows: [
    row('f1', 'shop', [agent('p-f1', 'First done', 'done', { terminal: 'term-1', summary: summary() })]),
    row('f2', 'shop', [agent('p-f2', 'Second done', 'done', { terminal: 'term-2', summary: summary() })])
  ] }
  const ui = emptyUi()
  ui.unfolded.add('finished')
  const footer = render(two, ui).footer
  assert.match(footer, /data-act="closeall">Sleep all</)
  assert.match(footer, /Finished · 2</, 'the Sleep all line is not counted as a session')
  assert.match(footer, /First done[\s\S]*data-yes="close:p-f1">sleep</, 'one session sleeps without asking')
  ui.confirming = 'closeall'
  assert.match(render(two, ui).footer, /Sleep 2 sessions\? <button class="yes" data-yes="closeall">Yes/)
})

test('coordinators show no team characters on the right', () => {
  const { main } = render(snap, emptyUi())
  noMatch(main, /class="r troops"/)
})

test('rows keep the order their workstreams started in, whatever their activity', () => {
  const rows = [
    row('newer', 'shop', [agent('p-n', 'Newer work', 'working')], { createdAt: 200, lastActivityAt: 999 }),
    row('older', 'shop', [agent('p-o', 'Older work', 'working')], { createdAt: 100, lastActivityAt: 1 })
  ]
  const { main } = render({ ...snap, rows }, emptyUi())
  assert.ok(main.indexOf('Older work') < main.indexOf('Newer work'))
})

test('finished rows show memory once known, and a spinner while it loads', () => {
  const one: Snapshot = { ...snap, rows: [row('f1', 'shop', [agent('p-f1', 'First done', 'done', { terminal: 'term-1', summary: summary() })])] }
  const ui = emptyUi()
  ui.unfolded.add('finished')
  ui.statsLoading = true
  assert.match(render(one, ui).footer, /First done[\s\S]*class="refreshing"/)
  ui.statsLoading = false
  ui.stats = { swap: null, ram: null, started: [], heaviest: [], merged: [],
    finished: [{ paneKey: 'p-f1', terminal: 'term-1', workspaceId: 'f1', title: 'First done', repo: 'shop', memMB: 430 }] }
  assert.match(render(one, ui).footer, /First done[\s\S]*430 MB/)
})

test('a coordinator row opens its session, folds with its chevron, and New coordinator follows the list', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-coordinator="alpha"/)
  assert.match(main, /class="coord-fold" data-fold="alpha"/)
  const withSleeper: Snapshot = { ...snap, coordinators: [...snap.coordinators, { key: 'ops', name: 'ops', repos: [], workspaceId: null }] }
  const sleepy = render(withSleeper, emptyUi()).main
  assert.match(sleepy, /data-coordinator="ops"[\s\S]*?<span class="name">ops<\/span><span class="sub">all projects<\/span>/, 'a sleeping coordinator gets the same full row')
  assert.ok(sleepy.indexOf('data-coordinator="ops"') > sleepy.indexOf('chats you started'), 'sleeping coordinators come after the active groups')
  assert.match(main, /data-new-coordinator>[\s\S]*New coordinator/)
  assert.ok(main.indexOf('data-new-coordinator') > main.lastIndexOf('<section class="coordinator">'))
})

test('new coordinators are offered looks nobody has; rows wear their look', () => {
  const taken = [{ key: 'a', name: 'a', repos: [], workspaceId: null, look: { color: '#5b8def', shape: 'hex' as const } }]
  const free = freeLooks(taken)
  assert.equal(free.length, 29)
  assert.ok(!free.some((l) => l.color === '#5b8def' && l.shape === 'hex'))
  const s6: Snapshot = { ...snap, coordinators: taken, rows: [] }
  assert.match(render(s6, emptyUi()).main, /data-coordinator="a"[^>]*>[\s\S]*?fill="#5b8def"/)
})

test('characters carry a one- or two-word status tooltip', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-tip="Waiting on you" data-tone="ask">/)
  assert.match(main, /data-tip="Working">/)
  const blocked: Snapshot = { ...snap, rows: [row('b', 'shop', [agent('p-b', 'Permission', 'blocked')])] }
  assert.match(render(blocked, emptyUi()).main, /data-tip="Needs approval"/)
  for (const tip of main.match(/data-tip="[^"]*"/g) ?? []) assert.ok(tip.split(' ').length <= 4, `${tip} is too long`)
})

test('every finished session offers close, even before its terminal is known', () => {
  const fresh: Snapshot = { ...snap, rows: [row('f', 'shop', [agent('p-new', 'Just finished', 'done', { terminal: null, summary: summary() })])] }
  const ui = emptyUi()
  ui.unfolded.add('finished')
  assert.match(render(fresh, ui).footer, /Just finished[\s\S]*data-yes="close:p-new"/)
})

test('characters with nothing reaching outside the body are drawn centered', () => {
  assert.match(character('#4fbfc8', 'hex', 'done', 56, false), /viewBox="0 0 56 56"/)
  noMatch(character('#4fbfc8', 'hex', 'asks', 56, false), /viewBox="0 0 56 56"/, 'the raised hand needs room')
  assert.ok(!/viewBox="0 0 20 20"/.test(character('#4fbfc8', 'solo', 'working', 20)), 'a badge needs room')
})

test('the tree has a Coordinators section title', () => {
  assert.match(render(snap, emptyUi()).main, /<div class="tree"><div class="label">Coordinators<\/div>/)
})

test('Orca\'s waiting always means waiting on you, and its question shows in Up next', () => {
  const calm = summary({ needs: { type: 'none', ask: '', options: [] } })
  const asking = agent('p-q', 'Orca plugin UI', 'waiting', { summary: calm, question: 'Which agent-row actions do you want in the menu?' })
  assert.equal(faceOf(asking), 'asks', 'a summary saying nothing is needed does not override Orca')
  const { main } = render({ ...snap, rows: [row('q', 'orca-plugin', [asking])] }, emptyUi())
  assert.match(main, /Asks · question[\s\S]*Which agent-row actions do you want in the menu\?/)
  noMatch(main, /Finished/)
})

test('agent and coordinator rows say which context menu they get', () => {
  const { main } = render(snap, emptyUi())
  assert.match(main, /data-menu="agent:p-dup"/)
  assert.match(main, /data-menu="coordinator:alpha"/)
})

test('Up next lists every asking agent, even several in one workspace', () => {
  const two = row('w', 'orca-plugin', [
    agent('p-a', 'State test: question', 'waiting', { question: 'Which color?' }),
    agent('p-b', 'State test: decision', 'done', { summary: asks('Merge the test branch?') })
  ])
  const { main } = render({ ...snap, rows: [two] }, emptyUi())
  assert.match(main, /Up next · 2/)
  assert.match(main, /data-brief="p-a"[\s\S]*data-brief="p-b"|data-brief="p-b"[\s\S]*data-brief="p-a"/)
})

test('a title that leaks an id falls back to the workspace name', () => {
  const leak = row('main', 'orca-plugin', [agent('p-l', 'worker-task_475ea547ab76', 'working')])
  const { main } = render({ ...snap, rows: [leak] }, emptyUi())
  noMatch(main, /worker-task_475ea547ab76/)
})

test('actions show their progress inline on the row, not in a toast', () => {
  const ui = emptyUi()
  ui.status.set('agent:p-dup', { text: 'Sleeping…', tone: 'pending' })
  ui.status.set('coordinator:alpha', { text: 'Waking…', tone: 'pending' })
  const { main } = render(snap, ui)
  assert.match(main, /data-menu="agent:p-dup"[^>]*>[\s\S]*?class="rstatus pending"><span class="refreshing"><\/span>Sleeping…/)
  assert.match(main, /data-menu="coordinator:alpha"[\s\S]*?class="rstatus pending"><span class="refreshing"><\/span>Waking…/)
  ui.status.set('agent:p-dup', { text: 'PR not merged', tone: 'bad' })
  assert.match(render(snap, ui).main, /class="rstatus bad">PR not merged/)
})

test('a coordinator shows its own state: available while only its workers work', () => {
  const session = agent('p-home', 'Home', 'done')
  const awake: Snapshot = { ...snap, coordinators: [{ ...snap.coordinators[0], session }, snap.coordinators[1]] }
  const head = (s: Snapshot, key: string) => /<button class="coord-open"[^>]*>[\s\S]*?<\/button>/.exec(render(s, emptyUi()).main.split(`data-menu="coordinator:${key}"`)[1])![0]
  assert.match(head(awake, 'alpha'), /data-tip="Available"/)
  assert.match(head(awake, 'main'), /data-tip="Sleeping"/)
  const busy: Snapshot = { ...awake, coordinators: [{ ...snap.coordinators[0], session: { ...session, state: 'working' } }, snap.coordinators[1]] }
  assert.match(head(busy, 'alpha'), /data-tip="Working"/)
})

test('asking shows as a ? badge on the character, not a count on the coordinator row', () => {
  assert.match(character('#fff', 'worker', 'asks', 20), /class="ask-badge"[\s\S]*>\?<\/text>/)
  noMatch(character('#fff', 'worker', 'working', 20), /ask-badge/)
  noMatch(render(snap, emptyUi()).main, /class="asking"/)
})

test('PR indicators match Orca: checks color an open PR, the state colors the rest', () => {
  const pr = (state: string, checks: 'success' | 'pending' | 'failure' | 'cancelled' | null = null) => prBadge({ number: 7, url: 'u', state, checks })
  assert.match(pr('open', 'failure'), /class="pr pr-fail" role="link" data-pr="u" data-tip="PR #7 checks failed"/, 'clicking it opens the PR')
  assert.match(pr('open', 'pending'), /class="pr pr-pending" role="link" data-pr="u" data-tip="PR #7 checks pending"/)
  assert.match(pr('open', 'success'), /class="pr pr-ok" role="link" data-pr="u" data-tip="PR #7 open"/)
  assert.match(pr('open'), /class="pr pr-ok"/, 'no checks yet: open is green')
  assert.match(pr('merged', 'failure'), /class="pr pr-merged" role="link" data-pr="u" data-tip="PR #7 merged"/, 'checks only color an open PR')
  assert.match(pr('closed'), /class="pr pr-closed"/)
  assert.match(pr('draft'), /class="pr pr-draft"/)
  assert.equal(prBadge(null), '')
  const withPr: Snapshot = { ...snap, rows: [row('w', 'shop', [agent('p-w', 'Checkout', 'working')], { pr: { number: 12, url: 'u', state: 'open', checks: 'pending' } })] }
  assert.match(render(withPr, emptyUi()).main, /Checkout<\/span><span class="r">[\s\S]*?class="pr pr-pending"/, 'the row shows its worktree\'s PR')
})

test('a lead whose worker is still working stays in the tree as available, with the worker under it', () => {
  const lead = agent('p-lead', 'Onboarding', 'done', { coordinator: 'alpha' })
  const reviewer = agent('p-rev', 'Review PR', 'working', { coordinator: 'alpha', leadPane: 'p-lead' })
  const s: Snapshot = { ...snap, rows: [row('ob', 'shop', [reviewer, lead])] }
  const { main, footer } = render(s, emptyUi())
  assert.match(main, /data-tip="Available"[\s\S]*?Onboarding[\s\S]*?class="item indent"[\s\S]*?Review PR/, 'the lead heads the tree and its worker nests under it')
  noMatch(footer, /Onboarding/)
  assert.deepEqual(finishedAgents(s.rows).map((a) => a.paneKey), [], 'Sleep all leaves the lead alone')
  const done: Snapshot = { ...snap, rows: [row('ob', 'shop', [{ ...reviewer, state: 'done' }, lead])] }
  assert.deepEqual(finishedAgents(done.rows).map((a) => a.paneKey).sort(), ['p-lead', 'p-rev'], 'once its workers are done, it is finished too')
})
