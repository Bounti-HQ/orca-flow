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
- An ask needs a question the user can answer RIGHT NOW. A heads-up about a later step is not one: "releasing waits for your go-ahead", "I'll ask you once the PR is up", "merging needs your OK later" while the work it depends on is still running or not yet there means needs.type "none" and glance "", with what it waits on first in "watching". Never turn such a statement into a question.
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

const HOOKS_DIR = join(ORCA_DATA, 'agent-hooks')

type Found = { path: string } | { path: null; why: string }

/**
 * Where Orca's hook state records a pane's Claude transcript. Current Orca keeps that state in
 * SQLite (agent-hooks/last-status.db: one `entry\0<pane>` row per pane, its JSON value carrying
 * `providerSession.transcriptPath`); older Orca wrote agent-hooks/last-status.json. Reads the
 * database first, the JSON file second, and says why when neither has a transcript on disk.
 */
export function findTranscript(pane: string, files = { db: join(HOOKS_DIR, 'last-status.db'), json: join(HOOKS_DIR, 'last-status.json') }): Found {
  const misses: string[] = []
  for (const [file, read] of [[files.db, entryFromDb], [files.json, entryFromJson]] as const) {
    if (!existsSync(file)) {
      misses.push(`${file} does not exist`)
      continue
    }
    let entry: any
    try {
      entry = read(file, pane)
    } catch (e) {
      misses.push(`${file}: ${(e as Error).message}`)
      continue
    }
    const path = entry?.providerSession?.transcriptPath ?? entry?.transcriptPath
    if (typeof path === 'string' && existsSync(path)) return { path }
    misses.push(entry ? `${file} names ${typeof path === 'string' ? `${path}, which does not exist` : 'no transcript'}` : `${file} has no entry for the pane`)
  }
  return { path: null, why: misses.join('; ') }
}

export function transcriptOf(pane: string, files?: { db: string; json: string }): string | null {
  return findTranscript(pane, files).path
}

/**
 * The newest entry row for the pane. Opened read-only: Orca writes the database live in WAL mode.
 * `node:sqlite` comes from the runtime (Node 22.13+ unflagged; Orca's plugin host runs Node 24), so
 * the plugin needs no native build; on a runtime without it the JSON fallback still applies.
 */
function entryFromDb(file: string, pane: string): any {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) throw new Error('this runtime has no node:sqlite')
  const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 1000 })
  try {
    // Rows are keyed `entry\0<pane>`; match on the value's paneKey too, in case the key layout changes.
    const rows = db.prepare(`SELECT value FROM rows WHERE key = ? OR (substr(key, 1, 5) = 'entry' AND instr(value, ?) > 0) ORDER BY seq DESC`)
      .all(`entry\0${pane}`, JSON.stringify(pane)) as { value: string }[]
    for (const row of rows) {
      const entry = JSON.parse(row.value)
      if (entry?.paneKey === pane) return entry
    }
    return null
  } finally {
    db.close()
  }
}

function entryFromJson(file: string, pane: string): any {
  return JSON.parse(readFileSync(file, 'utf8'))?.entries?.[pane] ?? null
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
 * A coordinator relays its leads' and workers' questions ("the lead is waiting on you, try it").
 * Those asks belong to the agent that asked, which shows its own question badge; repeated on the
 * coordinator they show the same ask twice. So a coordinator's card asks only what the user must
 * answer to the coordinator itself.
 */
export const COORDINATOR_ASKS = `This agent is a COORDINATOR: it routes work to leads and workers, which have their own cards. For "needs", count only a question the user must answer TO THE COORDINATOR ITSELF: which project or coordinator takes a request, approving a worktree removal, approving freeing memory or stopping a session, or a fact it needs before it can start work. A question it relays or summarizes from a lead or worker, or one that tells the user to answer, try or review something in another agent's chat, is NOT its ask: set needs.type "none" and glance "" (name what it waits on in "watching", e.g. "lead's review").`

/** What Haiku reads for one turn: the role's rules, the card so far, and the turn itself. */
export function promptFor(d: Digest, previous: { title?: string; about?: string } | null, goal?: string): string {
  return [
    d.role === 'coordinator' && COORDINATOR_ASKS,
    goal && `Coordinator's goal for this workstream: ${goal}`,
    previous?.title && `Previous title: ${previous.title}${previous.about ? `\nPrevious about: ${previous.about}` : ''}`,
    `FIRST REQUEST:\n${d.firstPrompt}`,
    `LATEST TURN:\n${d.turn}`,
    `AGENT'S FINAL MESSAGE THIS TURN:\n${d.lastAssistant || '(none)'}`
  ].filter(Boolean).join('\n\n')
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
  const { summary } = await callHaiku(promptFor(d, previous, input.goal))
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
  findTranscript?: (pane: string) => Found
  delayMs?: number
  /** Waits before looking again for a transcript that was not there yet. */
  retryMs?: number[]
  parallel?: number
  log?: (message: string) => void
}) {
  const find = opts.findTranscript ?? ((pane: string) => findTranscript(pane))
  // A missing transcript means no summary at all; say so once, loudly, instead of failing silently.
  let warned = false
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
      // A new session can report its first status a moment before Claude creates its transcript
      // file, so a miss is looked up again before it counts.
      const retries = opts.retryMs ?? [5000, 15_000]
      const attempt = (n: number, delay: number) => {
        clearTimeout(timers.get(pane))
        timers.set(pane, setTimeout(() => {
          timers.delete(pane)
          const found = find(pane)
          if (found.path !== null) return enqueue({ pane, transcript: found.path, worktreeId: event.workspaceId ?? undefined })
          if (n < retries.length) return attempt(n + 1, retries[n])
          if (warned) return
          warned = true
          opts.log?.(`SUMMARIES OFF: no Claude transcript found for pane ${pane}, so its turn was not summarized (${found.why}). Further misses are not logged.`)
        }, delay))
      }
      attempt(0, opts.delayMs ?? 2000)
    },
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      queue.length = 0
    }
  }
}
