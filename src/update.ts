// "Update available" in the status bar, and the update itself on click. Orca reports no update
// information for a Git install, so the worker reads the repository's version tags. The update
// runs `orca plugin update <key>` in a detached shell that outlives this worker (Orca stops the
// worker when it installs the new version) and leaves its result in RESULT_DIR for the next worker.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO = 'https://github.com/cyucelen/orca-flow.git'

// ---------- versions ----------

type Version = [number, number, number]

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return 0
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** Release versions from `git ls-remote --tags --refs` (refs/tags/vX.Y.Z); anything else is skipped. */
export function versionsFromTags(lsRemote: string): string[] {
  return lsRemote.split('\n').map((l) => /refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(l.trim())?.[1]).filter((v): v is string => Boolean(v)).map((v) => v.slice(1))
}

/** The newest release above `current`, or null. */
export function newerVersion(current: string, versions: string[]): string | null {
  const newest = [...versions].sort(compareVersions).at(-1)
  return newest && compareVersions(newest, current) > 0 ? newest : null
}

export function latestRelease(git = ['/usr/bin/git', '/opt/homebrew/bin/git', 'git'].find((p) => p === 'git' || existsSync(p))!): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(git, ['ls-remote', '--tags', '--refs', REPO], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin:/bin:/opt/homebrew/bin' } }, (err, stdout) => {
      if (err) return reject(new Error(err.message.split('\n')[0]))
      resolve(versionsFromTags(stdout))
    })
  })
}

// ---------- what the status bar item says ----------

export type UpdateState =
  | { kind: 'none' }
  | { kind: 'available'; version: string }
  | { kind: 'confirm'; version: string }
  | { kind: 'updating'; version: string }
  | { kind: 'updated'; version: string }
  | { kind: 'approval'; version: string; command: string; reason: string }
  | { kind: 'failed'; version: string; reason: string }

/** How an update ended, as the status bar shows it. */
export type UpdateOutcome = Extract<UpdateState, { kind: 'updated' | 'approval' | 'failed' }>

export type UpdateItem = {
  id: 'update'
  visible: boolean
  text?: string
  icon?: 'download' | 'refresh' | 'check' | 'warning' | 'error'
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip?: string
}

export function updateItem(state: UpdateState): UpdateItem {
  const base = { id: 'update' as const }
  switch (state.kind) {
    case 'none':
      return { ...base, visible: false }
    case 'available':
      return { ...base, visible: true, text: `Orca Flow ${state.version} available`, icon: 'download' as const, tone: 'accent' as const, tooltip: `Click to update Orca Flow to ${state.version}` }
    case 'confirm':
      return { ...base, visible: true, text: `Update to ${state.version}? Click again`, icon: 'download' as const, tone: 'warning' as const, tooltip: 'Click again within 15 seconds to update; Orca Flow restarts on the new version' }
    case 'updating':
      return { ...base, visible: true, text: `Updating to ${state.version}…`, icon: 'refresh' as const, tone: 'neutral' as const, tooltip: 'Orca is installing the new version' }
    case 'updated':
      return { ...base, visible: true, text: `Orca Flow updated to ${state.version}`, icon: 'check' as const, tone: 'success' as const, tooltip: 'Running the new version' }
    case 'approval':
      return { ...base, visible: true, text: `Orca Flow ${state.version} needs your approval`, icon: 'warning' as const, tone: 'warning' as const, tooltip: `${state.reason}\nTo approve and update, run:\n${state.command}` }
    case 'failed':
      return { ...base, visible: true, text: `Orca Flow ${state.version} update failed`, icon: 'error' as const, tone: 'danger' as const, tooltip: `${state.reason}\nClick to try again` }
  }
}

/**
 * A click on the item. Available asks for a second click; a second click starts the update. An
 * approval or a failure explains itself (its text is what Orca shows for the command's result).
 */
export function onClick(state: UpdateState): { next: UpdateState; start: boolean; message: string } {
  switch (state.kind) {
    case 'available':
    case 'failed':
      return { next: { kind: 'confirm', version: state.version }, start: false, message: `Update Orca Flow to ${state.version}? Click the status bar item again to update.` }
    case 'confirm':
      return { next: { kind: 'updating', version: state.version }, start: true, message: `Updating Orca Flow to ${state.version}…` }
    case 'approval':
      return { next: state, start: false, message: `Orca Flow ${state.version} asks for new access, so it was not installed. ${state.reason} To approve and update, run: ${state.command}` }
    case 'updating':
      return { next: state, start: false, message: `Already updating to ${state.version}.` }
    default:
      return { next: state, start: false, message: 'Orca Flow is up to date.' }
  }
}

// ---------- running the update outside the worker ----------

/** What `orca plugin update --json` printed and how it exited, as the next worker finds it. */
export function resultOf(exit: number, output: string, key: string, version: string): UpdateOutcome {
  let parsed: any = null
  try {
    parsed = JSON.parse(output)
  } catch {}
  if (exit === 0 && parsed?.ok !== false) return { kind: 'updated', version: parsed?.result?.version ?? version }
  const code = parsed?.error?.code ?? ''
  if (exit === 3 || code === 'approval_required' || code === 'approval_stale') {
    const fp = parsed?.error?.data?.approvalFingerprint
    // Never approved here: the person reads what it asks for and runs the command themselves.
    return { kind: 'approval', version, reason: parsed?.error?.message ?? 'The new version asks for different access.', command: `orca plugin update ${key}${fp ? ` --approve ${fp}` : ''}` }
  }
  return { kind: 'failed', version, reason: parsed?.error?.message ?? (output.trim().split('\n').at(-1) || `orca plugin update exited ${exit}`) }
}

/** Starts the update in a shell that outlives this worker; it writes `exit` and `out.json` to `dir`. */
export function startUpdate(orcaBin: string, key: string, version: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pending.json'), JSON.stringify({ key, version, at: Date.now() }))
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const script = `${q(orcaBin)} plugin update ${q(key)} --json > ${q(join(dir, 'out.json'))} 2>&1; echo $? > ${q(join(dir, 'exit.tmp'))}; mv ${q(join(dir, 'exit.tmp'))} ${q(join(dir, 'exit'))}`
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * What the last update left: null when none ran, 'pending' while its shell has not finished, or its
 * outcome. Running version `current` already at the target counts as updated, whatever the files say.
 */
export function readUpdateResult(dir: string, current: string): UpdateOutcome | 'pending' | null {
  let pending: { key: string; version: string; at: number } | null = null
  try {
    pending = JSON.parse(readFileSync(join(dir, 'pending.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pending) return null
  if (compareVersions(current, pending.version) >= 0) return { kind: 'updated', version: current }
  if (!existsSync(join(dir, 'exit'))) return Date.now() - pending.at < 5 * 60_000 ? 'pending' : { kind: 'failed', version: pending.version, reason: 'The update did not report back.' }
  const exit = Number(readFileSync(join(dir, 'exit'), 'utf8').trim())
  let out = ''
  try {
    out = readFileSync(join(dir, 'out.json'), 'utf8')
  } catch {}
  return resultOf(Number.isFinite(exit) ? exit : 1, out, pending.key, pending.version)
}
