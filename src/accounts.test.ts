// Settings → Account switching's discovery: projections, aliases and failures over synthetic Orca answers.
import { assert, test } from 'orca/testing'
import { currentWorkspace, discoverAccounts, ENFORCEMENT, projectClaude, projectCodex, readFailure } from './accounts.ts'

// Shaped like Orca 1.4.272's accounts.list blocks; every identity and path here is made up.
const claudeBlock = () => ({
  accounts: [
    { id: 'acct-c1', email: 'dev@studio.example', managedAuthRuntime: 'host', wslDistro: null, authMethod: 'oauth', organizationUuid: 'org-studio', organizationName: 'Studio', home: '/fixture/home/claude/acct-c1', createdAt: 1, updatedAt: 3 },
    { id: 'acct-c2', email: 'qa@studio.example', displayName: 'QA', managedAuthRuntime: 'host', organizationUuid: 'org-studio', organizationName: 'Studio', home: '/fixture/home/claude/acct-c2', needsSignIn: true, updatedAt: 2 },
    { id: 'acct-c3', email: 'dev@studio.example', managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu', organizationUuid: 'org-studio', updatedAt: 1 }
  ],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} },
  systemDefaultHome: '/fixture/home/.claude',
  systemDefaultEmail: 'DEV@studio.example',
  systemDefaultOrganizationUuid: 'org-studio'
})
const codexBlock = () => ({
  accounts: [
    { id: 'acct-x1', email: 'dev@studio.example', managedHomeRuntime: 'host', providerAccountId: 'prov-1', workspaceLabel: 'Studio', workspaceAccountId: 'ws-1', updatedAt: 3 },
    { id: 'acct-x2', email: 'ops@studio.example', managedHomeRuntime: 'host', providerAccountId: 'prov-2', workspaceLabel: 'Studio', updatedAt: 2 },
    { id: 'acct-x3', email: 'contractor@acme.example', managedHomeRuntime: 'host', providerAccountId: 'prov-3', workspaceLabel: 'Acme', updatedAt: 1 }
  ],
  activeAccountId: 'acct-x2',
  activeAccountIdsByRuntime: { host: 'acct-x2', wsl: {} },
  systemDefault: { hasAuth: true, authKind: 'oauth', email: 'dev@studio.example', providerAccountId: 'prov-1', workspaceLabel: 'Studio' }
})

test('Claude: this host’s logins only, System default collapsed onto its login, a name keeps its email', () => {
  assert.deepEqual(projectClaude(claudeBlock()), [
    { id: 'acct-c1', label: 'dev@studio.example', organization: 'Studio', systemDefault: true, needsSignIn: false },
    { id: 'acct-c2', label: 'QA (qa@studio.example)', organization: 'Studio', systemDefault: false, needsSignIn: true }
  ])
})

test('Claude: an alias that matches two logins, or another organization, is never guessed', () => {
  const block = claudeBlock()
  block.accounts.push({ id: 'acct-c4', email: 'dev@studio.example', managedAuthRuntime: 'host', organizationUuid: 'org-studio', updatedAt: 0 } as never)
  assert.deepEqual(projectClaude(block).map((a) => a.systemDefault), [false, false, false], 'two logins match: none is System default')
  assert.deepEqual(projectClaude({ ...claudeBlock(), systemDefaultOrganizationUuid: 'org-other' }).map((a) => a.systemDefault), [false, false])
  const covered = claudeBlock()
  ;(covered.accounts[1] as Record<string, unknown>).runsOnSystemDefault = true
  assert.deepEqual(projectClaude({ ...covered, systemDefaultEmail: undefined }).map((a) => a.systemDefault), [false, true], 'Orca says it runs on System default')
})

test('Codex: System default is the login with the same email and provider account', () => {
  assert.deepEqual(projectCodex(codexBlock()), [
    { id: 'acct-x1', label: 'dev@studio.example', organization: 'Studio', systemDefault: true, needsSignIn: false },
    { id: 'acct-x2', label: 'ops@studio.example', organization: 'Studio', systemDefault: false, needsSignIn: false },
    { id: 'acct-x3', label: 'contractor@acme.example', organization: 'Acme', systemDefault: false, needsSignIn: false }
  ])
  const other = { ...codexBlock(), systemDefault: { hasAuth: true, email: 'dev@studio.example', providerAccountId: 'prov-9' } }
  assert.equal(projectCodex(other).some((a) => a.systemDefault), false, 'same email, another provider account: not an alias')
  assert.equal(projectCodex({ ...codexBlock(), systemDefault: { hasAuth: false } }).some((a) => a.systemDefault), false)
})

test('a projection carries no path, token, provider account or organization id', () => {
  const out = JSON.stringify([projectClaude(claudeBlock()), projectCodex(codexBlock())])
  for (const leak of ['/fixture', 'org-studio', 'prov-', 'ws-1', 'home', 'Ubuntu', 'oauth']) assert.equal(out.includes(leak), false, `projection leaks ${leak}`)
  assert.deepEqual(Object.keys(projectClaude(claudeBlock())[0]).sort(), ['id', 'label', 'needsSignIn', 'organization', 'systemDefault'])
})

test('discovery only lists, one provider at a time, and one failing never hides the other', async () => {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args.includes('codex')) throw new Error('Unknown flag --agent for /fixture/bin/orca')
    return claudeBlock()
  }
  const state = await discoverAccounts(run)
  assert.deepEqual(calls.sort(), [['account', 'list', '--agent', 'claude'], ['account', 'list', '--agent', 'codex']])
  assert.equal(state.claude.accounts.length, 2)
  assert.equal(state.claude.error, null)
  assert.deepEqual(state.codex, { accounts: [], error: 'This Orca can’t list Codex accounts. Update Orca to see them here.' })
  assert.deepEqual(state.enforcement, ENFORCEMENT)
  assert.equal(state.enforcement.transfer, false, 'no host offers a supported transfer yet')
  assert.equal(state.enforcement.paidUsageStop, false, 'nor a stop before paid usage')
})

test('discovery failures read as one of a few fixed lines, never Orca’s own text', async () => {
  const state = await discoverAccounts(async () => ({ ok: true }))
  assert.equal(state.claude.error, 'Orca’s answer about Claude accounts couldn’t be read.')
  assert.equal(readFailure('claude', new Error('spawn /fixture/bin/orca ENOENT')), 'Orca’s command line isn’t available, so accounts can’t be listed.')
  assert.equal(readFailure('codex', new Error('orca account list timed out')), 'Orca took too long to list Codex accounts.')
  // An unknown error may carry a home path or an identity: it is never forwarded.
  const generic = 'Couldn’t read Claude accounts. Try again, or check Settings → AI Provider Accounts in Orca.'
  assert.equal(readFailure('claude', new Error('permission denied reading /fixture/home/.claude/x.json\nstack')), generic)
  assert.equal(readFailure('claude', new Error('Account dev@studio.example in org org-studio is locked')), generic)
  assert.equal(readFailure('claude', Object.assign(new Error('Unexpected error'), { code: 'internal', data: { home: '/fixture/home' } })), generic)
  assert.equal(readFailure('claude', 'a thrown string with /fixture/home'), generic)
  const leaked = (await discoverAccounts(async () => { throw new Error('dev@studio.example: token at /fixture/home/.codex/auth.json expired') })).codex.error ?? ''
  for (const leak of ['@', '/fixture', 'token']) assert.equal(leaked.includes(leak), false, `the panel never gets ${leak}`)
})

test('System default needs identity evidence: missing organization or provider account on both sides is none', () => {
  const claudeNoOrg = { accounts: [{ id: 'acct-c1', email: 'dev@studio.example', managedAuthRuntime: 'host' }], systemDefaultEmail: 'dev@studio.example' }
  assert.equal(projectClaude(claudeNoOrg)[0].systemDefault, false, 'email alone is no proof')
  assert.equal(projectClaude({ ...claudeNoOrg, systemDefaultOrganizationUuid: 'org-studio' })[0].systemDefault, false, 'an organization on one side only')
  assert.equal(projectClaude({ accounts: [{ ...claudeNoOrg.accounts[0], organizationUuid: 'org-studio' }], systemDefaultEmail: 'dev@studio.example' })[0].systemDefault, false, 'and on the other side only')
  assert.equal(projectClaude({ ...claudeNoOrg, accounts: [{ ...claudeNoOrg.accounts[0], runsOnSystemDefault: true }] })[0].systemDefault, true, 'Orca saying so explicitly still counts')
  const codexNoAccount = { accounts: [{ id: 'acct-x1', email: 'dev@studio.example', managedHomeRuntime: 'host', workspaceLabel: 'Studio' }], systemDefault: { hasAuth: true, email: 'dev@studio.example', workspaceLabel: 'Studio' } }
  assert.equal(projectCodex(codexNoAccount)[0].systemDefault, false, 'same email and workspace name, no provider account: no proof')
  assert.equal(projectCodex({ ...codexNoAccount, systemDefault: { hasAuth: true, email: 'dev@studio.example' } })[0].systemDefault, false, 'nothing but the email')
  assert.equal(projectCodex({ accounts: [{ ...codexNoAccount.accounts[0], providerAccountId: 'prov-1' }], systemDefault: { hasAuth: true, email: 'dev@studio.example' } })[0].systemDefault, false, 'a provider account on one side only')
})

test('the current workspace: one focused workspace, else its coordinator’s folder, else none', () => {
  const row = (id: string, name: string, active: boolean, historical = false) => ({ id, name, active, historical })
  const c = (name: string, workspaceId: string | null, active: boolean) => ({ name, workspaceId, active })
  assert.deepEqual(currentWorkspace({ rows: [row('identity:a', 'atlas', true), row('identity:a', 'atlas', true), row('identity:b', 'billing', false)], coordinators: [] }), { id: 'identity:a', name: 'atlas' })
  assert.equal(currentWorkspace({ rows: [row('identity:a', 'atlas', true), row('identity:b', 'billing', true)], coordinators: [] }), null, 'two focused: never guess')
  assert.equal(currentWorkspace({ rows: [row('identity:a', 'atlas', true, true)], coordinators: [] }), null, 'a past member is not focus')
  assert.deepEqual(currentWorkspace({ rows: [row('identity:a', 'atlas', false)], coordinators: [c('flow-lab', 'folder:flow-lab', true)] }), { id: 'folder:flow-lab', name: 'flow-lab' })
  assert.equal(currentWorkspace({ rows: [], coordinators: [c('harbor', null, true)] }), null, 'a coordinator without its workspace yet')
  assert.equal(currentWorkspace(null), null)
})
