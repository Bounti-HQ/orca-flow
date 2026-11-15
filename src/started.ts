// What agents started that Orca does not count: dev servers and other processes that detached from
// the agent's terminal. Orca's memory report covers each session's own process tree; a detached
// process is reparented to launchd and drops out of it. Every process inherits its parent's
// environment, so it still carries the ORCA_WORKTREE_ID and ORCA_PANE_KEY of the terminal it came
// from. A process whose title hides its environment (next-server renames itself) belongs to its
// nearest tagged parent.
import { execFile } from 'node:child_process'
import type { StartedGroup, WorkspaceRow } from './protocol.ts'

export type Proc = { pid: number; ppid: number; name: string; worktree: string | null; pane: string | null }

/** Pure: `ps -axE -ww -o pid=,ppid=,command=` (command line followed by the environment). */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const text = m[3]
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: nameOf(text.split(/\s[A-Z_][A-Z0-9_]*=/)[0]),
      worktree: / ORCA_WORKTREE_ID=\S*?::(\S+)/.exec(text)?.[1] ?? null,
      pane: / ORCA_PANE_KEY=(\S+)/.exec(text)?.[1] ?? null
    })
  }
  return procs
}

/** "node …/.bin/next dev" -> "next"; "next-server (v16.4.5)" -> "next-server". */
function nameOf(command: string): string {
  const parts = command.trim().split(/\s+/)
  const base = (s = '') => s.split('/').pop() ?? s
  const first = base(parts[0])
  return /^(node|bun|deno|python3?|ruby)$/.test(first) && parts[1] && !parts[1].startsWith('-') ? base(parts[1]) : first
}

/** Pure: footprint per pid in bytes from `top -l 1 -stats pid,mem` ("64417  972M+"). */
export function parseTop(out: string): Map<number, number> {
  const unit: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  const bytes = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/.exec(line)
    if (m) bytes.set(Number(m[1]), Number(m[2]) * unit[m[3]])
  }
  return bytes
}

type Owned = { proc: Proc; key: string; row: WorkspaceRow; pane: string | null }

/**
 * Pure: each process an agent started outside its session, with the worktree and pane that started
 * it. Processes inside a session's tree are left out (Orca already counts them), and a tag only
 * counts for a worktree the panel knows, so text that merely looks like a tag is ignored.
 */
function owned(procs: Proc[], sessionPids: number[], rows: WorkspaceRow[]): Owned[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const children = new Map<number, number[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid])
  const inSession = new Set<number>()
  const stack = [...sessionPids]
  while (stack.length) {
    const pid = stack.pop()!
    if (inSession.has(pid)) continue
    inSession.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  const rowOf = new Map(rows.filter((r) => r.path).map((r) => [r.path!, r]))
  const out: Owned[] = []
  for (const proc of procs) {
    if (inSession.has(proc.pid)) continue
    let p: Proc | undefined = proc
    for (let depth = 0; p && p.pid > 1 && depth < 64 && !(p.worktree && rowOf.has(p.worktree)); depth++) p = byPid.get(p.ppid)
    const row = p?.worktree ? rowOf.get(p.worktree) : undefined
    if (row) out.push({ proc, key: `${row.path}|${p!.pane ?? ''}`, row, pane: p!.pane })
  }
  return out
}

/** Pure: started processes grouped by worktree and pane, heaviest first, named by their heaviest process. */
export function startedGroups(procs: Proc[], footprint: Map<number, number>, sessionPids: number[], rows: WorkspaceRow[]): StartedGroup[] {
  const groups = new Map<string, StartedGroup & { top: number }>()
  for (const { proc, key, row, pane } of owned(procs, sessionPids, rows)) {
    const bytes = footprint.get(proc.pid) ?? 0
    const g = groups.get(key) ?? { key, path: row.path!, paneKey: pane, workspaceId: row.id, worktreeName: row.name, repo: row.repo, name: proc.name, count: 0, memMB: 0, top: -1 }
    g.count++
    g.memMB += bytes / 1024 ** 2
    if (bytes > g.top) Object.assign(g, { top: bytes, name: proc.name })
    groups.set(key, g)
  }
  return [...groups.values()].map(({ top, ...g }) => ({ ...g, memMB: Math.round(g.memMB) })).sort((a, b) => b.memMB - a.memMB)
}

// ---------- reading the machine ----------

function out(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => resolve(String(stdout ?? ''))))
}

export const readProcs = async (): Promise<Proc[]> => parsePs(await out('ps', ['-axE', '-ww', '-o', 'pid=,ppid=,command=']))
export const readFootprint = async (): Promise<Map<number, number>> => parseTop(await out('top', ['-l', '1', '-stats', 'pid,mem', '-n', '5000']))
