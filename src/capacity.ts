// The capacity decision, shared by the plugin worker and `orca-flow capacity` so they never
// disagree. What slows the machine is memory, not how many worktrees or agents exist, so capacity
// is one budget: the memory Orca reports as available, minus a safety margin. A start fits when its
// cost does. Costs are measured on this machine: a typical agent session, and per project the
// processes its worktrees started (dev servers). Memory pressure overrides the numbers.
export type Pressure = 'normal' | 'warn' | 'critical' | 'unknown'
/** ok: a new worktree with its environment fits. agents-only: another agent fits, an environment does not. */
export type Verdict = 'ok' | 'agents-only' | 'full' | 'pressure'
export type CapacityConfig = { marginGB: number }

export const DEFAULT_CONFIG: CapacityConfig = { marginGB: 2 }
/** Used until there is something to measure. */
export const FALLBACK = { agentGB: 0.5, envGB: 1.5 }

const round = (n: number) => Math.round(n * 10) / 10
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * Pure: what starting things costs here. An agent: the median of open agent sessions (a terminal
 * with no agent in it is a few MB and does not count). A project's environment: the median of what
 * its worktrees' agents started outside their sessions.
 */
export function costsOf(agentSessionsGB: number[], startedByWorktree: { repo: string; gb: number }[]): { agentGB: number; envGB: Record<string, number> } {
  const byRepo = new Map<string, number[]>()
  for (const w of startedByWorktree) if (w.gb > 0) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w.gb])
  return {
    agentGB: round(median(agentSessionsGB.filter((g) => g >= 0.1)) ?? FALLBACK.agentGB),
    envGB: Object.fromEntries([...byRepo].map(([repo, gbs]) => [repo, round(median(gbs)!)]))
  }
}

/** Pure: free disk in GB from `df -k -P <dir>` (the Available column of its one data line). */
export function diskFreeOf(df: string): number | null {
  const fields = df.trim().split('\n')[1]?.trim().split(/\s+/)
  const kb = Number(fields?.[3])
  return Number.isFinite(kb) ? round(kb / 1024 ** 2) : null
}

/** A project's environment cost; a project never seen running one costs the fallback, to be safe. */
export const envCost = (envGB: Record<string, number>, repo?: string) => (repo && envGB[repo] !== undefined ? envGB[repo] : FALLBACK.envGB)

export function decide({ availableGB, pressure, config, agentGB, envGB }: {
  availableGB: number | null
  pressure: Pressure
  config: CapacityConfig
  agentGB: number
  /** The environment the start would bring, or the typical one when asking in general. */
  envGB: number
}): { verdict: Verdict; freeGB: number | null } {
  const freeGB = availableGB === null ? null : round(availableGB - config.marginGB)
  if (pressure === 'critical') return { verdict: 'pressure', freeGB }
  if (freeGB === null) return { verdict: pressure === 'warn' ? 'agents-only' : 'ok', freeGB }
  if (freeGB < agentGB) return { verdict: 'full', freeGB }
  if (pressure === 'warn' || freeGB < agentGB + envGB) return { verdict: 'agents-only', freeGB }
  return { verdict: 'ok', freeGB }
}
