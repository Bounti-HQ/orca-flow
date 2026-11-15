// The end-of-turn summarizer: reads an agent's Claude transcript and asks Haiku for a status card
// (title, about, the ask at a glance, what it is watching, a priority guess). Shared by the plugin
// worker, which runs it when Orca reports a finished turn, and `orca-flow summarize-run`.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(homedir(), '.orca-flow')
const AGENTS = join(DATA_DIR, 'agents')
const ORCA_DATA = join(homedir(), 'Library', 'Application Support', 'orca')

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'about', 'goal', 'since', 'needs', 'glance', 'watching', 'effort', 'priority'],
  properties: {
    title: { type: 'string', description: 'The workstream in 2-5 words, stable across turns, never the latest step' },
    about: { type: 'string', description: 'One sentence on what this workstream is for, stable across turns' },
    goal: { type: 'string', description: 'One sentence: the outcome the user asked for' },
    since: { type: 'string', description: 'At most 25 words: what concretely changed in the latest turn' },
    needs: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'ask', 'options'],
      properties: {
        type: { enum: ['none', 'decision', 'approval', 'review', 'info'] },
        ask: { type: 'string', description: 'One question in at most 25 words; empty if none' },
        options: { type: 'array', items: { type: 'string', description: 'A 1-5 word button label' }, maxItems: 4 }
      }
    },
    glance: { type: 'string', description: 'The ask in at most 8 words, as a question or an action; empty when needs.type is none' },
    watching: { type: 'string', description: 'What the agent is waiting on that is not the user, in at most 4 words ("E2E run", "CI", "its workers"); empty if nothing' },
    effort: { enum: ['quick', 'deep'], description: 'How long answering the ask takes the user' },
    priority: { enum: ['P0', 'P1', 'P2', 'P3'] }
  }
}

export const SYSTEM_PROMPT = `You write status cards for a developer who runs many coding agents in parallel and switches between them constantly. Each card must let them re-enter a workstream in seconds.

Rules:
- "title" names the workstream in 2-5 words ("Guest checkout", "Search ranking fix"), never the latest step. If a previous title is given and the work is the same, keep it.
- "about" is one plain sentence on what the workstream is for ("Let returning customers check out without re-entering their address."). Keep the previous one unless the goal changed.
- "glance" is the ask in at most 8 words, as the question or action itself ("Keep the old checkout behind a flag?", "Review the pricing page before Friday."). When the agent's final message asks the user something, restate THAT question; never invent a different one.
- The first request of an Orca worker starts with an orchestration preamble (Task and Dispatch ids, how to report). The actual task is the brief inside it; summarize that, not the preamble.
- "watching": when the turn ended waiting on something other than the user (tests, CI, a deploy, workers it started), name it in at most 4 words; otherwise empty.
- Never put ids, hashes, terminal names, file paths or URLs in title, about, glance or watching.
- Be concrete in "since": name PRs, tests, numbers. No filler, no "the agent".
- "since" is what changed in the latest turn only.
- "needs": what the agent is waiting on from the user right now. "none" if the turn ended with work finished and nothing asked, and "none" when it is waiting on something else: workers it started, a background job, a long-running command, CI. Only a question or decision for the user counts. "approval" = yes/no on something prepared; "decision" = choose between options; "review" = look at a diff/PR/result; "info" = a fact only the user has. Ask ONE question in at most 25 words; if the agent asked several, ask the most important and say "(+2 more)". Options are 1-5 word labels like "Merge", "Keep both", "Ask each time", never sentences.
- "effort": "quick" if the user can answer in under a minute.
- "priority" guess: P0 now = blocking production, a customer or a release; P1 today = critical path of current focus; P2 soon = matters but can wait a day; P3 someday = exploration. When unsure pick the lower level.
Write in English even if the conversation is in another language.`

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
}

/**
 * An Orca dispatch wraps the real brief in a long preamble (ids, how to report). Only the text after
 * its `=== TASK ===` marker is the task; the preamble would drown it out.
 */
export function briefOf(text: string): string {
  const i = text.indexOf('=== TASK ===')
  if (i < 0) return text
  return text.slice(i + '=== TASK ==='.length).replace(/<\/pasted_content>[\s\S]*$/, '').trim()
}

type Role = 'lead' | 'worker' | 'coordinator' | 'solo'
type Event = { kind: 'user' | 'assistant' | 'tool'; text: string; raw?: string; at?: string }

/** Decided from facts, not by the model: a lead's first prompt names its role; a dispatched
 * worker's carries its Dispatch id; a coordinator is an agent that started workers. */
export function roleOf(firstPrompt: string, events: Event[]): Role {
  if (/your role: lead\b/i.test(firstPrompt)) return 'lead'
  if (/dispatch[ _-]?id|worker_done/i.test(firstPrompt)) return 'worker'
  // Only a command that runs it, not one that merely mentions it (in a heredoc, a grep, a test).
  const runs = /^Bash: (?:.*(?:&&|;)\s*)?(?:\S*\/)?orca orchestration worker-start\b/
  if (events.some((e) => e.kind === 'tool' && runs.test(e.text))) return 'coordinator'
  return 'solo'
}

export type Digest = { role: Role; firstPrompt: string; turn: string; lastAssistant: string; turnAt: string | null }

/** Condense a Claude Code transcript into what the summarizer needs. */
export function digest(lines: string[]): Digest | null {
  const events: Event[] = []
  for (const line of lines) {
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain) continue
    const content = d.message?.content
    if (d.type === 'user') {
      if (Array.isArray(content) && content.some((c: any) => c.type === 'tool_result')) continue
      const raw = textOf(content).trim()
      const text = briefOf(raw)
      // A dispatched worker's first message carries its Dispatch id: keep that fact for roleOf.
      if (text) events.push({ kind: 'user', text, raw, at: d.timestamp })
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text.trim()) events.push({ kind: 'assistant', text: c.text.trim(), at: d.timestamp })
        if (c.type === 'tool_use') {
          const detail = c.input?.command ?? c.input?.file_path ?? c.input?.description ?? ''
          events.push({ kind: 'tool', text: `${c.name}${detail ? `: ${clip(String(detail).replace(/\s+/g, ' '), 140)}` : ''}`, at: d.timestamp })
        }
      }
    }
  }
  const prompts = events.filter((e) => e.kind === 'user')
  if (prompts.length === 0) return null
  // The latest turn, plus the one before it for context.
  const startPrompt = prompts.at(-2) ?? prompts.at(-1)!
  const tail = events.slice(events.indexOf(startPrompt))
  const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant')
  const body = tail
    .filter((e) => e !== lastAssistant)
    .map((e) => (e.kind === 'user' ? `USER: ${clip(e.text, 1500)}` : e.kind === 'assistant' ? `AGENT: ${clip(e.text, 800)}` : `  → ${e.text}`))
    .join('\n')
  return {
    role: roleOf(prompts[0].raw ?? prompts[0].text, events),
    firstPrompt: clip(prompts[0].text, 1500),
    turn: clip(body, 10_000),
    lastAssistant: lastAssistant ? clip(lastAssistant.text, 4000) : '',
    turnAt: events.at(-1)?.at ?? null
  }
}

// ---------- finding things on this Mac ----------

/** Orca's hook state records every agent pane's Claude transcript path. */
export function transcriptOf(pane: string, statusFile = join(ORCA_DATA, 'agent-hooks', 'last-status.json')): string | null {
  try {
    const entry = JSON.parse(readFileSync(statusFile, 'utf8'))?.entries?.[pane]
    const path = entry?.providerSession?.transcriptPath ?? entry?.transcriptPath
    return typeof path === 'string' && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/** The plugin worker does not inherit the shell's PATH, so look where Claude Code installs. */
export function claudeBin(): string {
  const home = homedir()
  return [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude')
  ].find((p) => existsSync(p)) ?? 'claude'
}

/** The Claude login Orca's agents use (its selected profile), so Haiku bills the same account. */
export function claudeConfigDir(): string | null {
  try {
    const dir = readFileSync(join(ORCA_DATA, 'claude-profiles', 'selected-host'), 'utf8').trim()
    return dir && existsSync(dir) ? dir : null
  } catch {
    return null
  }
}

function callHaiku(prompt: string): Promise<{ summary: any; costUSD?: number }> {
  // Strip Orca's agent variables so Orca does not mistake this call for an agent in a pane.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('ORCA_') && k !== 'CLAUDECODE') env[k] = v
  env.ORCA_CARD_CHILD = '1'
  env.MAX_THINKING_TOKENS = '0'
  // Orca starts plugin workers without HOME/USER, and without them Claude cannot find its login in
  // the macOS Keychain ("Not logged in").
  env.HOME ??= homedir()
  env.USER ??= userInfo().username
  const config = claudeConfigDir()
  if (config) env.CLAUDE_CONFIG_DIR = config
  const args = [
    '-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--disable-slash-commands', '--setting-sources', '', '--system-prompt', SYSTEM_PROMPT,
    '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA)
  ]
  return new Promise((resolve, reject) => {
    // The prompt goes on stdin: `claude -p` waits for stdin to close, and a transcript can be long.
    const child = execFile(claudeBin(), args, { env, maxBuffer: 8 * 1024 * 1024, timeout: 90_000, cwd: homedir() }, (err, stdout, stderr) => {
      if (err) return reject(new Error(errorOf(stdout, stderr) || err.message.split('\n')[0]))
      try {
        const out = JSON.parse(stdout)
        if (out.is_error) return reject(new Error(out.result ?? 'claude -p error'))
        resolve({ summary: out.structured_output ?? JSON.parse(out.result), costUSD: out.total_cost_usd })
      } catch (e) {
        reject(e as Error)
      }
    })
    child.stdin?.end(prompt)
  })
}

/** Claude's own words for a failure: the JSON result if it printed one, else stderr's last line. */
function errorOf(stdout: string, stderr: string): string {
  try {
    const out = JSON.parse(stdout)
    if (out?.result) return String(out.result)
  } catch {}
  return stderr.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Warning: no stdin')).at(-1) ?? ''
}

// ---------- the card on disk ----------

const fileKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_')

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Write via a temp file and rename, so the panel never reads half a file. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/**
 * Summarizes one pane's latest turn into ~/.orca-flow/agents/<pane>.json. Skips a turn already
 * summarized, and keeps the newest when two finish close together. Returns what it did.
 */
export async function summarizePane(input: { pane: string; transcript: string; worktreeId?: string; goal?: string; force?: boolean; dir?: string }): Promise<'written' | 'skipped' | 'empty'> {
  const out = join(input.dir ?? AGENTS, `${fileKey(input.pane)}.json`)
  const d = digest(readFileSync(input.transcript, 'utf8').split('\n'))
  if (!d) return 'empty'
  const previous = readJson(out)
  if (!input.force && previous?.turnAt && d.turnAt && previous.turnAt >= d.turnAt) return 'skipped'
  const prompt = [
    input.goal && `Coordinator's goal for this workstream: ${input.goal}`,
    previous?.title && `Previous title: ${previous.title}${previous.about ? `\nPrevious about: ${previous.about}` : ''}`,
    `FIRST REQUEST:\n${d.firstPrompt}`,
    `LATEST TURN:\n${d.turn}`,
    `AGENT'S FINAL MESSAGE THIS TURN:\n${d.lastAssistant || '(none)'}`
  ].filter(Boolean).join('\n\n')
  const { summary } = await callHaiku(prompt)
  // A newer turn may have finished while Haiku ran; keep the newest.
  const latest = readJson(out)
  if (!input.force && latest?.turnAt && d.turnAt && latest.turnAt > d.turnAt) return 'skipped'
  writeJson(out, { pane: input.pane, worktreeId: input.worktreeId ?? '', transcript: input.transcript, turnAt: d.turnAt, updatedAt: Date.now(), role: d.role, ...summary })
  return 'written'
}

// ---------- when to summarize ----------

type StatusEvent = { paneKey: string; workspaceId: string | null; state: string }
type Job = { pane: string; transcript: string; worktreeId?: string }

/**
 * Runs the summarizer when Orca reports that an agent's turn ended (done) or it asked the user
 * something (waiting). Waits a moment so the transcript is flushed, coalesces bursts per pane,
 * keeps one run per pane and at most `parallel` Haiku calls at once (each is a node process).
 */
export function turnSummarizer(opts: {
  run: (job: Job) => Promise<unknown>
  transcriptOf?: (pane: string) => string | null
  delayMs?: number
  parallel?: number
  log?: (message: string) => void
}) {
  const find = opts.transcriptOf ?? transcriptOf
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const again = new Map<string, Job>()
  const queue: Job[] = []

  const pump = () => {
    while (running.size < (opts.parallel ?? 2)) {
      const i = queue.findIndex((j) => !running.has(j.pane))
      if (i < 0) return
      const [job] = queue.splice(i, 1)
      running.add(job.pane)
      opts.run(job)
        .catch((e) => opts.log?.(`summary for ${job.pane} failed: ${(e as Error).message}`))
        .finally(() => {
          running.delete(job.pane)
          const next = again.get(job.pane)
          if (next) {
            again.delete(job.pane)
            queue.push(next)
          }
          pump()
        })
    }
  }

  const enqueue = (job: Job) => {
    if (running.has(job.pane)) return void again.set(job.pane, job)
    const i = queue.findIndex((j) => j.pane === job.pane)
    if (i >= 0) queue[i] = job
    else queue.push(job)
    pump()
  }

  return {
    onStatus(event: StatusEvent): void {
      if (event.state !== 'done' && event.state !== 'waiting') return
      const pane = event.paneKey
      clearTimeout(timers.get(pane))
      timers.set(pane, setTimeout(() => {
        timers.delete(pane)
        const transcript = find(pane)
        if (transcript) enqueue({ pane, transcript, worktreeId: event.workspaceId ?? undefined })
      }, opts.delayMs ?? 2000))
    },
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      queue.length = 0
    }
  }
}
