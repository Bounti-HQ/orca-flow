// From a patched disposable host checkout, run the host tests and sandboxed provider CLIs
// in separate processes. Orca's normal Vitest guard against invoking live providers stays on.
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve, join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {verifyCliContinuity} from './cli-continuity.mjs'

const checkout = resolve(process.argv[2] ?? '.')
const dir = await mkdtemp(join(tmpdir(), 'orca-worker-continuity-'))
const child = spawn(join(checkout, 'node_modules/.bin/vitest'),
  ['run', '--config', 'config/vitest.config.ts', 'src/main/account-switch-e2e/worker-continuity.test.ts'],
  {cwd: checkout, stdio: 'inherit', env: {...process.env, ORCA_WORKER_E2E_BRIDGE: dir}})
const exited = once(child, 'exit')
async function phase(name, turn, stopTerminal) {
  const path = join(dir, turn.provider + '-' + name)
  await writeFile(path + '.tmp', JSON.stringify(turn))
  await rename(path + '.tmp', path)
  const deadline = Date.now() + 100_000
  while (Date.now() < deadline) {
    if (stopTerminal) {
      try {
        await readFile(path + '.stop')
        await stopTerminal()
        await writeFile(path + '.exited', '')
        stopTerminal = null
      } catch (err) { if (err.code !== 'ENOENT') throw err }
    }
    try {
      await readFile(path + '.ok')
      return
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    try {
      const failure = await readFile(path + '.failed', 'utf8')
      throw new Error('Host assertion at ' + name + ': ' + failure)
    } catch (err) { if (err.code !== 'ENOENT') throw err }
    if (child.exitCode !== null || child.signalCode) throw new Error('Host fixture ended before ' + name)
    await delay(50)
  }
  throw new Error('Timed out waiting for host fixture at ' + name)
}
try {
  await verifyCliContinuity(['claude', 'codex'], Object.fromEntries(
    ['initialTurnFinished', 'beforeResume', 'replacementReady', 'resumeVerified'].map(name => [name, (turn, stopTerminal) => phase(name, turn, stopTerminal)])))
  const [code] = await exited
  if (code !== 0) throw new Error('Host fixture failed with exit code ' + code)
} finally {
  if (child.exitCode === null && !child.signalCode) child.kill()
  await exited
  await rm(dir, {recursive: true, force: true})
}
