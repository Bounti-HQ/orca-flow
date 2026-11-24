// The user's settings as ~/.orca-flow/config.json holds them, and as the Settings dialog edits them.
// Pure: the worker reads and writes the file (src/config.ts), the panel draws and edits (src/panel/settings.ts).
// Existing keys keep their names and meaning; their readers are src/worker.ts, src/capacity.ts,
// skills/orca-flow/scripts/stop-check.mjs and skills/orca-flow/scripts/orca-flow.mjs.

import { DEFAULT_ROUTING, normalizeRouting, type RoutingSettings } from './routing.ts'

export type WriterProvider = 'claude' | 'codex' | 'antigravity'
/** One writer in `writers`, tried in list order. `model` is absent for a writer without a choice. */
export type WriterSetting = { provider: WriterProvider; model?: string; enabled: boolean }
/** Absent or "off": no check; "all": every coordinator and lead; a list: agents working under those folders. */
export type MessageFormat = 'off' | 'all' | string[]
/** Parts of Orca Flow that show only when switched on (Settings → Features). Display only: a switch never touches Orca's own data. */
export type FeatureSettings = { bots: boolean; goals: boolean; linear: boolean; tokenSpeed: boolean }
/**
 * One workspace's deviation from the default (on, every eligible login): switching off, or Orca's ids
 * of managed logins never to continue on. Exclusions only ever remove destinations.
 */
export type AccountOverride = { enabled: boolean; exclude: { claude: string[]; codex: string[] } }
/**
 * Settings → Account switching, by workspace (its Orca Flow row id). Only deviations are stored; a
 * workspace with none is absent. A preference only: it authorizes no sharing (each workspace's scope
 * is the host's), and nothing enforces it until the host can (src/accounts.ts).
 */
export type AccountSwitchingSettings = { workspaces: Record<string, AccountOverride> }
export type FlowSettings = { writers: WriterSetting[]; messageFormat: MessageFormat; marginGB: number; warnHeadroomGB: number; linearDryRun: boolean; routing: RoutingSettings; features: FeatureSettings; accountSwitching: AccountSwitchingSettings }
export type SettingsKey = keyof FlowSettings

export const WRITER_PROVIDERS: readonly WriterProvider[] = ['claude', 'codex', 'antigravity']
/** The models each CLI accepts by name, the default first. */
export const WRITER_MODELS: Record<WriterProvider, readonly string[]> = { claude: ['haiku', 'sonnet'], codex: ['gpt-6-luna'], antigravity: ['gemini-3.8-flash-low', 'gemini-4-carbon-low', 'gemini-4-neon-low', 'gemini-4-hydrogen-low', 'gemini-4-argon-low'] }
/**
 * Writers Orca Flow can run. Antigravity runs in an isolated temporary workspace with a `tools: []`
 * custom agent, `inheritCustomizations: false`, `inheritMcp: false`, strict deny rules, and stdin
 * `stream-json` input.
 */
export const WRITABLE: readonly WriterProvider[] = ['claude', 'codex', 'antigravity']

/** Today's behaviour: Haiku, then GPT-6 Luna through Codex. Must match DEFAULT_CONFIG in src/capacity.ts. */
export const DEFAULT_SETTINGS: FlowSettings = {
  writers: [
    { provider: 'claude', model: 'haiku', enabled: true },
    { provider: 'codex', model: 'gpt-6-luna', enabled: true },
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', enabled: false }
  ],
  messageFormat: 'off',
  marginGB: 2,
  warnHeadroomGB: 2,
  linearDryRun: false,
  routing: DEFAULT_ROUTING,
  features: { bots: false, goals: false, linear: true, tokenSpeed: true },
  accountSwitching: { workspaces: {} }
}
/** What a workspace without an override gets: on, for every eligible login. */
export const DEFAULT_ACCOUNT_OVERRIDE: AccountOverride = { enabled: true, exclude: { claude: [], codex: [] } }
export const SETTINGS_KEYS: readonly SettingsKey[] = ['writers', 'messageFormat', 'marginGB', 'warnHeadroomGB', 'linearDryRun', 'routing', 'features', 'accountSwitching']

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The writers list, in order, each provider once. A provider the list leaves out is off, and goes last.
 * An unknown model falls back to the provider's default; a writer Orca Flow cannot run is off.
 * Not a list, or no usable entry: today's default, so a typo never stops cards.
 */
export function normalizeWriters(value: unknown): WriterSetting[] {
  if (!Array.isArray(value)) return clone(DEFAULT_SETTINGS.writers)
  const out: WriterSetting[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const provider = entry.provider as WriterProvider
    if (!WRITER_PROVIDERS.includes(provider) || out.some((w) => w.provider === provider)) continue
    out.push(writer(provider, entry.model, entry.enabled !== false))
  }
  if (!out.length) return clone(DEFAULT_SETTINGS.writers)
  for (const provider of WRITER_PROVIDERS) if (!out.some((w) => w.provider === provider)) out.push(writer(provider, undefined, false))
  return out
}

function writer(provider: WriterProvider, model: unknown, enabled: boolean): WriterSetting {
  const models = WRITER_MODELS[provider]
  const on = enabled && WRITABLE.includes(provider)
  // Key order is fixed (provider, model, enabled): `same` compares by JSON.
  return models.length ? { provider, model: models.includes(model as string) ? (model as string) : models[0], enabled: on } : { provider, enabled: on }
}

export function normalizeFormat(value: unknown): MessageFormat {
  if (value === 'all') return 'all'
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim())
  return 'off'
}

/** The feature switches. Bots and Goals are off unless exactly true; Linear and Analytics are shown today, so they are on unless exactly false (Analytics is stored as `tokenSpeed`, its name before 0.2.87, so older files keep working). An older or broken file changes nothing on screen. */
export function normalizeFeatures(value: unknown): FeatureSettings {
  const f = isObject(value) ? value : {}
  return { bots: f.bots === true, goals: f.goals === true, linear: f.linear !== false, tokenSpeed: f.tokenSpeed !== false }
}

/** One override: on unless exactly false; each provider's exclusions as unique, sorted ids. */
export function normalizeAccountOverride(value: unknown): AccountOverride {
  const a = isObject(value) ? value : {}
  const ex = isObject(a.exclude) ? a.exclude : {}
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))].sort() : [])
  return { enabled: a.enabled !== false, exclude: { claude: ids(ex.claude), codex: ids(ex.codex) } }
}

/**
 * Account switching: each workspace's override, in id order, dropping any that equal the default. An
 * older file (no key) or a broken value reads as on for every login everywhere.
 */
export function normalizeAccountSwitching(value: unknown): AccountSwitchingSettings {
  const ws = isObject(value) && isObject(value.workspaces) ? value.workspaces : {}
  const out: Record<string, AccountOverride> = {}
  for (const id of Object.keys(ws).filter((k) => k.trim()).sort()) {
    const o = normalizeAccountOverride(ws[id])
    if (!same(o, DEFAULT_ACCOUNT_OVERRIDE)) out[id] = o
  }
  return { workspaces: out }
}

/** A workspace's preference: its override, else the default. */
export const accountOverrideFor = (s: AccountSwitchingSettings, workspace: string): AccountOverride =>
  clone(s.workspaces[workspace] ?? DEFAULT_ACCOUNT_OVERRIDE)

/** One edit on the Account switching page, for the workspace it was opened in. */
export type AccountChange =
  | { kind: 'enabled'; enabled: boolean }
  | { kind: 'exclude'; provider: 'claude' | 'codex'; id: string; excluded: boolean }
  | { kind: 'reset' }

/** The change as sent by the panel, or null when it is not one (the worker refuses it). */
export function accountChangeOf(value: unknown): AccountChange | null {
  if (!isObject(value)) return null
  if (value.kind === 'reset') return { kind: 'reset' }
  if (value.kind === 'enabled' && typeof value.enabled === 'boolean') return { kind: 'enabled', enabled: value.enabled }
  if (value.kind === 'exclude' && (value.provider === 'claude' || value.provider === 'codex') && typeof value.id === 'string' && value.id.trim() && value.id.length <= 256 && typeof value.excluded === 'boolean')
    return { kind: 'exclude', provider: value.provider, id: value.id.trim(), excluded: value.excluded }
  return null
}

/** A workspace id the panel may save under: a non-empty string of reasonable length. */
export const accountWorkspaceOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() && value.length <= 512 ? value : null)

/**
 * The config object with one workspace's account preference changed, starting from `raw` as the
 * file holds it now. Every other workspace, and every other key, stays exactly as written.
 */
export function applyAccountChange(raw: Record<string, unknown>, workspace: string, change: AccountChange): Record<string, unknown> {
  const current = normalizeAccountSwitching(raw.accountSwitching)
  const o = accountOverrideFor(current, workspace)
  const next = change.kind === 'reset' ? clone(DEFAULT_ACCOUNT_OVERRIDE)
    : change.kind === 'enabled' ? { ...o, enabled: change.enabled }
    : { ...o, exclude: { ...o.exclude, [change.provider]: change.excluded ? [...o.exclude[change.provider], change.id] : o.exclude[change.provider].filter((id) => id !== change.id) } }
  const out: Record<string, unknown> = { ...raw }
  const saved = withAccountOverride(current, workspace, next)
  if (same(saved, DEFAULT_SETTINGS.accountSwitching)) delete out.accountSwitching
  else out.accountSwitching = saved
  return out
}

/** The settings with one workspace's preference set; back at the default, its override is removed. */
export function withAccountOverride(s: AccountSwitchingSettings, workspace: string, next: AccountOverride): AccountSwitchingSettings {
  return normalizeAccountSwitching({ workspaces: { ...s.workspaces, [workspace]: next } })
}

const gb = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

/** What a config object means, every key filled in; a missing or unusable value reads as its default. */
export function normalizeSettings(raw: unknown): FlowSettings {
  const c = isObject(raw) ? raw : {}
  return {
    writers: normalizeWriters(c.writers),
    messageFormat: normalizeFormat(c.messageFormat),
    marginGB: gb(c.marginGB, DEFAULT_SETTINGS.marginGB),
    warnHeadroomGB: gb(c.warnHeadroomGB, DEFAULT_SETTINGS.warnHeadroomGB),
    linearDryRun: c.linearDryRun === true,
    routing: normalizeRouting(c.routing),
    features: normalizeFeatures(c.features),
    accountSwitching: normalizeAccountSwitching(c.accountSwitching)
  }
}

/**
 * The config object after saving `next`: only the keys whose meaning changed are touched. A key set
 * back to its default is removed; a key never changed stays as written; unknown keys are kept.
 * `accountSwitching` is never written here: a whole-settings save comes from a dialog that may be
 * stale or from a caller that predates the key, so it keeps what the file holds. Account changes go
 * through applyAccountChange, one workspace at a time, against the file as it is then.
 */
export function applySettings(raw: Record<string, unknown>, next: FlowSettings): Record<string, unknown> {
  const now = normalizeSettings(raw)
  const want = normalizeSettings(next)
  const out: Record<string, unknown> = { ...raw }
  for (const key of SETTINGS_KEYS) {
    if (key === 'accountSwitching' || same(now[key], want[key])) continue
    if (same(want[key], DEFAULT_SETTINGS[key])) delete out[key]
    else out[key] = clone(want[key])
  }
  return out
}

// ---------- saving from a dialog opened before another change ----------

/** `want` where the dialog changed it (it differs from `base`), else what the file holds now. */
const pick = <T>(current: T, base: T, want: T): T => (same(want, base) ? current : clone(want))

/** Entries by id: only those the dialog added, edited or removed (against `base`) are applied over `current`. */
function mergeById<T extends { id: string }>(current: T[], base: T[], want: T[]): T[] {
  if (same(want, base)) return current
  const was = new Map(base.map((x) => [x.id, x]))
  const keep = new Set(want.map((x) => x.id))
  const out = current.filter((x) => !(was.has(x.id) && !keep.has(x.id)))
  for (const w of want) {
    const b = was.get(w.id)
    if (b && same(w, b)) continue
    const at = out.findIndex((x) => x.id === w.id)
    if (at >= 0) out[at] = clone(w)
    else out.push(clone(w))
  }
  return out
}

/** Routing three ways: the coordinator, the lead, each worker row, each task type and each saved preset are separate. */
function mergeRouting(current: RoutingSettings, base: RoutingSettings, want: RoutingSettings): RoutingSettings {
  const workers = { ...current.workers }
  for (const kind of Object.keys(workers) as (keyof RoutingSettings['workers'])[]) workers[kind] = pick(current.workers[kind], base.workers[kind], want.workers[kind])
  return {
    coordinator: pick(current.coordinator, base.coordinator, want.coordinator),
    lead: pick(current.lead, base.lead, want.lead),
    workers,
    types: mergeById(current.types, base.types, want.types),
    presets: mergeById(current.presets, base.presets, want.presets)
  }
}

/**
 * Account switching three ways, one workspace at a time: a workspace's override is the dialog's only
 * where the dialog changed that workspace, so another window's override for any workspace stays.
 */
function mergeAccounts(current: AccountSwitchingSettings, base: AccountSwitchingSettings, want: AccountSwitchingSettings): AccountSwitchingSettings {
  const ids = new Set([...Object.keys(current.workspaces), ...Object.keys(base.workspaces), ...Object.keys(want.workspaces)])
  const out: Record<string, AccountOverride> = {}
  for (const id of ids) {
    const o = pick(current.workspaces[id] ?? DEFAULT_ACCOUNT_OVERRIDE, base.workspaces[id] ?? DEFAULT_ACCOUNT_OVERRIDE, want.workspaces[id] ?? DEFAULT_ACCOUNT_OVERRIDE)
    if (!same(o, DEFAULT_ACCOUNT_OVERRIDE)) out[id] = clone(o)
  }
  return normalizeAccountSwitching({ workspaces: out })
}

/**
 * What a dialog's save should leave in the file when the dialog was opened (or last saved) with
 * `base` and the file holds `current` now, because another window or a hand edit changed it since:
 * only what the user changed in the dialog (`want` against `base`) is applied; every other setting
 * keeps the file's value. A setting both changed is the dialog's (last writer wins).
 */
export function mergeSettings(current: FlowSettings, base: FlowSettings, want: FlowSettings): FlowSettings {
  const [c, b, w] = [current, base, want].map(normalizeSettings)
  const features = { ...c.features }
  for (const k of Object.keys(features) as (keyof FeatureSettings)[]) features[k] = pick(c.features[k], b.features[k], w.features[k])
  return normalizeSettings({
    writers: pick(c.writers, b.writers, w.writers),
    messageFormat: pick(c.messageFormat, b.messageFormat, w.messageFormat),
    marginGB: pick(c.marginGB, b.marginGB, w.marginGB),
    warnHeadroomGB: pick(c.warnHeadroomGB, b.warnHeadroomGB, w.warnHeadroomGB),
    linearDryRun: pick(c.linearDryRun, b.linearDryRun, w.linearDryRun),
    routing: mergeRouting(c.routing, b.routing, w.routing),
    features,
    accountSwitching: mergeAccounts(c.accountSwitching, b.accountSwitching, w.accountSwitching)
  })
}

/** The settings to write for one save: merged over the file when the dialog says what it started from, else exactly `want`. */
export const settingsToSave = (current: FlowSettings, base: FlowSettings | undefined, want: FlowSettings): FlowSettings =>
  base ? mergeSettings(current, base, want) : normalizeSettings(want)

// ---------- the dialog's draft ----------

export type FormatChoice = 'off' | 'all' | 'folders'
/** The dialog's working copy, one field per control, so each page can count and reset its own changes. */
export type Draft = {
  writers: WriterProvider[]
  enabled: Record<WriterProvider, boolean>
  models: Record<WriterProvider, string>
  format: FormatChoice
  folders: string[]
  marginGB: number
  warnHeadroomGB: number
  linearDryRun: boolean
  routing: RoutingSettings
  bots: boolean
  goals: boolean
  linear: boolean
  tokenSpeed: boolean
  accountSwitching: AccountSwitchingSettings
}
export type DraftKey = keyof Draft
export const DEFAULT_FOLDERS = ['~/orca/coordinators']
/** What the dialog shows for a writer without a model choice. */
export const AGY_DEFAULT_MODEL = 'agy-default'

export function toDraft(s: FlowSettings): Draft {
  const writers = normalizeWriters(s.writers)
  const enabled = {} as Record<WriterProvider, boolean>
  const models = {} as Record<WriterProvider, string>
  for (const w of writers) {
    enabled[w.provider] = w.enabled
    models[w.provider] = w.model ?? AGY_DEFAULT_MODEL
  }
  const format = normalizeFormat(s.messageFormat)
  return {
    writers: writers.map((w) => w.provider), enabled, models,
    format: Array.isArray(format) ? 'folders' : format,
    folders: Array.isArray(format) ? format : [...DEFAULT_FOLDERS],
    marginGB: s.marginGB, warnHeadroomGB: s.warnHeadroomGB, linearDryRun: s.linearDryRun, routing: clone(normalizeRouting(s.routing)), ...normalizeFeatures(s.features),
    accountSwitching: normalizeAccountSwitching(s.accountSwitching)
  }
}

export function fromDraft(d: Draft): FlowSettings {
  return normalizeSettings({
    writers: d.writers.map((provider) => ({ provider, ...(WRITER_MODELS[provider].length ? { model: d.models[provider] } : {}), enabled: d.enabled[provider] })),
    messageFormat: d.format === 'folders' ? d.folders : d.format,
    marginGB: d.marginGB, warnHeadroomGB: d.warnHeadroomGB, linearDryRun: d.linearDryRun, routing: d.routing, features: { bots: d.bots, goals: d.goals, linear: d.linear, tokenSpeed: d.tokenSpeed },
    accountSwitching: d.accountSwitching
  })
}

export const DEFAULT_DRAFT: Draft = toDraft(DEFAULT_SETTINGS)
export const DRAFT_KEYS = Object.keys(DEFAULT_DRAFT) as DraftKey[]


// ---------- writer status ----------

/** What the worker knows of one writer: what it last saw, and whether Orca lists its CLI. No test calls. */
export type WriterStatus = {
  provider: WriterProvider
  /** When it last wrote a card in this worker, ms; null when it has not since the worker started. */
  lastSuccessAt: number | null
  /** Its last failure and when its cooldown ends (may be past: it is tried again at the next card). */
  failure: { kind: string; until: number } | null
  /** Whether `orca agent installed` lists its CLI; null when unknown. */
  installed: boolean | null
}

export type StatusView = { tone: 'ok' | 'warn' | 'bad' | 'idle'; text: string; sub: string; usable: boolean }

const FAILURE: Record<string, { tone: StatusView['tone']; text: string }> = {
  quota: { tone: 'warn', text: 'Usage limit' },
  auth: { tone: 'bad', text: 'Not signed in' },
  unavailable: { tone: 'bad', text: 'Unavailable' },
  timeout: { tone: 'warn', text: 'Timed out' },
  transient: { tone: 'warn', text: 'Temporary error' }
}
const NAME: Record<WriterProvider, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

export function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  return h < 48 ? 'yesterday' : `${Math.floor(h / 24)} days ago`
}

/** How the dialog shows a writer's status. `usable` says whether the next card would try it. */
export function statusView(s: WriterStatus | undefined, provider: WriterProvider, now: number): StatusView {
  if (!WRITABLE.includes(provider)) return { tone: 'idle', text: 'Not available yet', sub: `Orca Flow can’t write cards with the ${NAME[provider]} CLI yet`, usable: false }
  if (s?.failure) {
    const f = FAILURE[s.failure.kind] ?? { tone: 'bad' as const, text: 'Failed' }
    const left = s.failure.until - now
    if (left > 0) {
      const wait = left >= 60_000 ? `${Math.ceil(left / 60_000)} more min` : `${Math.ceil(left / 1000)} more s`
      return { ...f, sub: `Skipped for ${wait}, then tried again`, usable: false }
    }
    return { ...f, sub: 'Tried again at the next card', usable: true }
  }
  if (s?.lastSuccessAt) return { tone: 'ok', text: 'Ready', sub: `Last card ${ago(now - s.lastSuccessAt)}`, usable: true }
  if (s?.installed === false) return { tone: 'bad', text: 'Not installed', sub: `Orca doesn’t see the ${NAME[provider]} CLI`, usable: false }
  if (s?.installed === true) return { tone: 'ok', text: 'Installed', sub: 'No cards from it since Orca Flow started', usable: true }
  return { tone: 'idle', text: 'Not used yet', sub: 'No cards from it since Orca Flow started', usable: true }
}

// ---------- instant save ----------

/** What one save answered: the settings now in the file, or why nothing was written. */
export type SaveReply = { ok: boolean; error?: string; settings?: FlowSettings }

/**
 * The dialog's state with changes applied at once, as System Settings does: each change shows
 * immediately and is saved; while a save is in flight, later changes wait and go in one more save.
 * A failed save puts every control back to what the file holds and keeps the error. Each save also
 * says what the dialog started from (`base`), so the worker applies only what changed here.
 */
export function settingsSession(save: (settings: FlowSettings, base: FlowSettings) => Promise<SaveReply>, onUpdate: () => void = () => {}) {
  const s = { saved: clone(DEFAULT_DRAFT), shown: clone(DEFAULT_DRAFT), error: null as string | null }
  let saving: Promise<void> | null = null
  let again = false
  /** The folder list is kept while another choice is on, though only "Some folders" saves it. */
  const keepFolders = (d: Draft, from: Draft) => (d.format === 'folders' ? d : { ...d, folders: [...from.folders] })
  const run = async () => {
    do {
      again = false
      const want = fromDraft(s.shown)
      const base = fromDraft(s.saved)
      if (same(want, base)) break
      let reply: SaveReply
      try { reply = await save(want, base) } catch (e) { reply = { ok: false, error: (e as Error).message } }
      if (reply.ok && reply.settings) {
        s.saved = keepFolders(toDraft(reply.settings), s.shown)
        s.error = null
        // Changes made while this save ran go on top of what the file holds now, which may include another window's.
        s.shown = again ? keepFolders(toDraft(mergeSettings(reply.settings, want, fromDraft(s.shown))), s.shown) : clone(s.saved)
      } else {
        s.shown = clone(s.saved)
        s.error = reply.error ?? 'The settings could not be saved.'
        again = false
      }
      onUpdate()
    } while (again)
  }
  const flush = (): Promise<void> => {
    if (saving) { again = true; return saving }
    saving = run().finally(() => { saving = null })
    return saving
  }
  return {
    get saved() { return s.saved },
    get shown() { return s.shown },
    get error() { return s.error },
    /** The file's settings, as the dialog opens. */
    load(settings: FlowSettings) { s.saved = toDraft(settings); s.shown = clone(s.saved); s.error = null },
    /**
     * Takes Account switching as the file now holds it (after its own save, which never goes through
     * this session's saves), leaving every other control and any save in flight alone.
     */
    adopt(settings: FlowSettings) {
      const a = normalizeAccountSwitching(settings.accountSwitching)
      s.saved.accountSwitching = clone(a)
      s.shown.accountSwitching = clone(a)
      onUpdate()
    },
    /** Applies a change to the controls and saves it. */
    change(mutate: (d: Draft) => void): Promise<void> {
      mutate(s.shown)
      s.error = null
      onUpdate()
      return flush()
    },
    /** Puts some controls back to their defaults, in one save. */
    reset(keys: readonly DraftKey[]): Promise<void> {
      return this.change((d) => { for (const k of keys) (d as Record<string, unknown>)[k] = clone(DEFAULT_DRAFT[k]) })
    },
    isDefault: (keys: readonly DraftKey[]) => keys.every((k) => same(s.shown[k], DEFAULT_DRAFT[k]))
  }
}
