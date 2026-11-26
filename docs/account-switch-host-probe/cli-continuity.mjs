// macOS disposable continuity probe. Both real CLIs speak only to the loopback fixture.
// No provider accounts, provider requests, desktop settings, Orca panes or dispatches are used.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { startFixturePty } from './fixture-pty.mjs'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync, gunzipSync } from 'node:zlib'

const run = promisify(execFile)
const synthetic = ['fixture-A', 'fixture-B']
const first = 'Remember the offline marker ' + randomUUID()
const answer = 'first reply ' + randomUUID()
const followup = 'Continue the original fixture conversation.'
const requests = []
let admitReplacement = null
// The loopback provider gives each identity one included turn and leaves paid capacity enabled.
// These meters belong to the fixture. No claim is made about a real provider's reporting latency.
const meters = new Map(['claude', 'codex'].map(provider =>
  [provider, new Map(synthetic.map(account => [account, 0]))]))
function nextAccount(provider, current) {
  const usage = meters.get(provider)
  if (usage.get(current) < 100) return current
  return synthetic.find(account => usage.get(account) < 100) ?? null
}
const event = (type, fields) => 'event: ' + type + '\ndata: ' + JSON.stringify({type, ...fields}) + '\n\n'

const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let data = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'zstd') data = zstdDecompressSync(data)
    if (req.headers['content-encoding'] === 'gzip') data = gunzipSync(data)
    const claude = req.url.split('?')[0] === '/v1/messages'
    if (!claude && !req.url.endsWith('/responses')) {
      res.writeHead(404).end()
      return
    }
    const account = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '')
    assert.ok(synthetic.includes(account), 'unexpected client identity')
    const payload = JSON.parse(data)
    const input = JSON.stringify(claude ? payload.messages : payload.input)
    const reply = account === synthetic[0] ? answer : 'fixture complete'
    const provider = claude ? 'claude' : 'codex'
    requests.push({ account, model: payload.model, input, provider })
    if (input.includes(first) || input.includes(followup)) meters.get(provider).set(account, 100)
    if (account === synthetic[1] && input.includes(followup) && admitReplacement) {
      const admit = admitReplacement
      admitReplacement = null
      await admit({provider, model: payload.model, input, identity: account})
    }
    const id = 'msg_' + randomUUID()
    res.writeHead(200, {'content-type': 'text/event-stream'})
    if (claude) {
      const message = {id, type: 'message', role: 'assistant', model: payload.model, content: [],
        stop_reason: null, stop_sequence: null, usage: {input_tokens: 2, output_tokens: 0}}
      res.end(event('message_start', {message}) +
        event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) +
        event('content_block_delta', {index: 0, delta: {type: 'text_delta', text: reply}}) +
        event('content_block_stop', {index: 0}) +
        event('message_delta', {delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 2}}) +
        event('message_stop', {}))
    } else {
      const item = {id, type: 'message', role: 'assistant', status: 'completed',
        content: [{type: 'output_text', text: reply, annotations: []}]}
      const response = {id: 'resp_' + randomUUID(), object: 'response', model: payload.model}
      res.end(event('response.created', {response}) +
        event('response.output_item.added', {output_index: 0, item: {...item, content: [], status: 'in_progress'}}) +
        event('response.output_text.delta', {item_id: id, output_index: 0, content_index: 0, delta: reply}) +
        event('response.output_item.done', {output_index: 0, item}) +
        event('response.completed', {response: {...response, status: 'completed', output: [item]}}))
    }
  } catch (err) {
    console.error('Loopback fixture error:', err.message)
    res.destroy()
  }
})

async function probe(provider, root, port, lifecycle) {
  const bin = await realpath(execFileSync('/usr/bin/which', [provider], {encoding: 'utf8'}).trim())
  const hostHome = await realpath(homedir())
  const folder = join(root, provider)
  const cwd = join(folder, 'workspace')
  const shared = join(folder, 'history')
  await mkdir(cwd, {recursive: true})
  await mkdir(shared)
  const claude = provider === 'claude'
  const nodeBin = await realpath(process.execPath)
  const profile = [
    '(version 1)(allow default)(deny network*)',
    '(allow network-outbound (remote ip "localhost:' + port + '"))',
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))',
    '(deny file-read* file-write* (subpath ' + JSON.stringify(hostHome) + '))',
    ...[bin, nodeBin].map(path => '(allow file-read* (literal ' + JSON.stringify(path) + '))')
  ].join('\n')
  const address = 'http://127.0.0.1:' + port
  const model = claude ? 'claude-sonnet-4-6' : 'gpt-5.2'
  let session = claude ? randomUUID() : null
  let identity = synthetic[0]
  let terminal = null
  try {
    for (const [index, prompt] of [first, followup].entries()) {
      identity = nextAccount(provider, identity)
      assert.ok(identity, 'no authorized fixture identity has included usage')
      const home = join(folder, identity)
      const config = join(home, claude ? '.claude' : '.codex')
      await mkdir(config, {recursive: true})
      await symlink(shared, join(config, claude ? 'projects' : 'sessions'))
      const env = {HOME: home, TMPDIR: root, PATH: [dirname(nodeBin), '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter),
        TERM: 'dumb', LANG: 'en_US.UTF-8'}
      let args
      if (claude) {
        Object.assign(env, {CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: identity,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'})
        args = ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--model', model,
          '--output-format', 'json', index ? '--resume' : '--session-id', session, prompt]
      } else {
        Object.assign(env, {CODEX_HOME: config, FIXTURE_ACCOUNT: identity})
        await writeFile(join(config, 'config.toml'), [
          'model_provider = "fixture"', 'model = "' + model + '"', 'cli_auth_credentials_store = "file"',
          '[model_providers.fixture]', 'name = "offline"', 'base_url = "' + address + '/v1"',
          'env_key = "FIXTURE_ACCOUNT"', 'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0'
        ].join('\n'))
        args = ['exec', ...(index ? ['resume'] : []), '--json', '--skip-git-repo-check',
          ...(index ? [session, prompt] : [prompt])]
      }
      if (index) {
        const turn = {provider, session, model, cwd, identity}
        await lifecycle.beforeResume?.({...turn, ptyId: terminal?.ptyId}, () => terminal.stop())
        admitReplacement = async received => {
          assert.equal(received.identity, identity)
          assert.equal(received.provider, provider)
          assert.equal(received.model, model)
          for (const text of [first, answer, followup]) assert.ok(received.input.includes(text))
          await lifecycle.replacementReady?.({...turn, ptyId: terminal?.ptyId})
        }
      }
      const sandboxed = ['/usr/bin/sandbox-exec', '-p', profile, bin, ...args]
      let stdout
      if (lifecycle.initialTurnFinished) {
        // The host test acknowledges the old terminal's exit before this one is created.
        await terminal?.stop()
        terminal = await startFixturePty(sandboxed, {cwd, env}, home)
        ;({stdout} = await terminal.result())
      } else {
        const command = run(sandboxed[0], sandboxed.slice(1), {cwd, env, timeout: 45000})
        command.child.stdin.end()
        ;({stdout} = await command)
      }
      if (claude) {
        const result = JSON.parse(stdout)
        assert.equal(result.session_id, session)
        assert.equal(result.is_error, false)
      } else {
        const events = stdout.trim().split('\n').map(line => JSON.parse(line))
        const thread = events.find(e => e.type === 'thread.started')?.thread_id
        assert.ok(thread, 'missing Codex thread id')
        if (index) assert.equal(thread, session)
        else session = thread
        assert.ok(events.some(e => e.type === 'turn.completed'))
      }
      if (!index) await lifecycle.initialTurnFinished?.({provider, session, model, cwd, identity, ptyId: terminal?.ptyId})
    }
    const turns = requests.filter(r => r.provider === provider && (r.input.includes(first) || r.input.includes(followup)))
    assert.deepEqual(turns.map(t => t.account), synthetic)
    assert.deepEqual(turns.map(t => t.model), [model, model])
    for (const text of [first, answer, followup]) assert.ok(turns[1].input.includes(text), 'missing conversation on resume')
    assert.equal(nextAccount(provider, identity), null, 'exhausted pool must hold')
    await lifecycle.resumeVerified?.({provider, session, model, cwd, identity})
    console.log(provider + ': switched at the fixture’s 100% reading; same session, model and history; both spent, next turn held')
  } finally { await terminal?.stop() }
}

export async function verifyCliContinuity(providers = ['claude', 'codex'], lifecycle = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'orca-cli-continuity-'))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    for (const provider of providers) {
      requests.length = 0
      meters.set(provider, new Map(synthetic.map(account => [account, 0])))
      await probe(provider, root, server.address().port, lifecycle)
    }
  } finally {
    admitReplacement = null
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, {recursive: true, force: true})
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await verifyCliContinuity()
}
