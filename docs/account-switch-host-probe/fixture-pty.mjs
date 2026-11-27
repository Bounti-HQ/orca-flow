import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

export async function startFixturePty(command, {cwd, env}, outputDir) {
  const files = ['stdout', 'stderr', 'status'].map(name => join(outputDir, 'fixture-' + name))
  const driver = fileURLToPath(new URL('./fixture-pty.py', import.meta.url))
  const child = spawn('/usr/bin/python3', [driver, ...files, ...command], {cwd, env})
  const exited = once(child, 'exit')
  const startup = await Promise.race([
    once(child.stdout, 'data').then(([data]) => JSON.parse(String(data))),
    exited.then(() => { throw new Error('Disposable terminal exited before startup') })
  ])
  let closing
  return {
    ptyId: startup.ptyId,
    async result() {
      const end = Date.now() + 75_000
      for (;;) {
        try {
          const status = await readFile(files[2], 'utf8')
          if (Number(status.trim()) !== 0) throw new Error(await readFile(files[1], 'utf8'))
          return {stdout: await readFile(files[0], 'utf8')}
        } catch (error) {
          if (error.code !== 'ENOENT' || Date.now() > end || child.exitCode !== null) throw error
          await delay(40)
        }
      }
    },
    stop() {
      if (!closing) {
        child.stdin.end('stop\n')
        closing = exited.then(([code]) => {
          if (code !== 0) throw new Error('Could not confirm terminal exit')
        })
      }
      return closing
    }
  }
}
