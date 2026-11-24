// Settings → Account switching: which Orca-managed Claude and Codex logins a conversation may continue
// on, read on demand and reduced to what the page shows. Pure apart from the `run` it is given.
//
// Discovery reads `orca account list --agent claude|codex --json`, which asks Orca for its saved list
// without refreshing usage (the plain `orca account list --json` would refresh stale usage readings).
// It never selects, adds or removes an account, reads a token file or calls a provider.
//
// Finding a login only says it exists on this host. It never authorizes sharing a workspace's work
// with it, and never shows it has included usage left before a request: both are the host's to
// establish at the request boundary. docs/account-failover.md has the contract.

/** The providers Account switching covers. */
export type SwitchProvider = 'claude' | 'codex'
export const SWITCH_PROVIDERS: readonly SwitchProvider[] = ['claude', 'codex']
export const PROVIDER_NAME: Record<SwitchProvider, string> = { claude: 'Claude', codex: 'Codex' }

/**
 * One Orca-managed login, as much as the Settings page needs. Never a home folder, token, provider
 * account id or organization id: those stay in Orca.
 */
export type DiscoveredAccount = {
  /** Orca's id for the saved account, what an exclusion stores. */
  id: string
  /** The sign-in email, or the user's name for the account with the email beside it. */
  label: string
  /** The organization or workspace name Orca shows for it, when it has one. */
  organization: string | null
  /** The provider's own sign-in (System default) is this login: one account, never two. */
  systemDefault: boolean
  /** Orca needs a new sign-in before it can use the account. */
  needsSignIn: boolean
}

/** One provider's logins, or why they could not be read (then `accounts` is empty). */
export type ProviderAccounts = { accounts: DiscoveredAccount[]; error: string | null }

/**
 * What this Orca supports for the preferences. No Orca release offers a supported way to move a
 * running conversation to a chosen account, or to stop before a paid request, so neither is
 * supported yet. Change this only from an authoritative host status, never by guessing at an RPC.
 */
export type Enforcement = { transfer: false; paidUsageStop: false; transferReason: string; paidUsageReason: string }
export const ENFORCEMENT: Enforcement = {
  transfer: false,
  paidUsageStop: false,
  transferReason: 'This Orca has no supported way to move a running conversation to another account. Orca Flow never switches one, and shows no switch, until Orca can.',
  paidUsageReason: 'This Orca has no supported way to stop a conversation before a paid request. An account at 100% of its included usage goes on to paid usage as the provider allows.'
}
/** Where new launches get their account: Orca's own choice, which this page never changes. */
export const NEW_LAUNCHES = 'Orca picks the account each new agent launches with (its status bar account picker, or Settings → AI Provider Accounts). Account switching never changes that choice.'

export type AccountsState = { claude: ProviderAccounts; codex: ProviderAccounts; enforcement: Enforcement }

type Run = (args: string[], options?: { timeoutMs?: number }) => Promise<unknown>

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const lower = (v: unknown) => text(v)?.toLowerCase() ?? null

/** How Orca names an account on one line: a user-given name keeps the email beside it. */
function labelOf(email: string, displayName: unknown): string {
  const name = text(displayName)
  return name && name !== email ? `${name} (${email})` : email
}

/** The one account matching, or none: an ambiguous alias is never guessed. */
function onlyMatch<T>(items: T[], match: (item: T) => boolean): T | null {
  const found = items.filter(match)
  return found.length === 1 ? found[0] : null
}

/**
 * Orca's Claude block (`accounts`, `systemDefaultEmail`, `systemDefaultOrganizationUuid`). Only
 * this host's logins count: a WSL login runs elsewhere. System default is the login with the same
 * email and organization, or the one Orca says runs on it.
 */
export function projectClaude(block: unknown): DiscoveredAccount[] {
  if (!isObject(block) || !Array.isArray(block.accounts)) throw new Error('Orca returned no Claude account list')
  const host = block.accounts.filter((a): a is Record<string, unknown> => isObject(a) && !!text(a.id) && !!text(a.email) && (a.managedAuthRuntime ?? 'host') === 'host')
  const seen = new Set<string>()
  const unique = host.filter((a) => !seen.has(a.id as string) && !!seen.add(a.id as string))
  const sdEmail = lower(block.systemDefaultEmail)
  const sdOrg = text(block.systemDefaultOrganizationUuid)
  const alias = sdEmail ? onlyMatch(unique, (a) => lower(a.email) === sdEmail && (text(a.organizationUuid) ?? null) === sdOrg) : null
  return unique.map((a) => ({
    id: a.id as string,
    label: labelOf(text(a.email)!, a.displayName),
    organization: text(a.organizationName),
    systemDefault: a === alias || a.runsOnSystemDefault === true,
    needsSignIn: a.needsSignIn === true
  }))
}

/**
 * Orca's Codex block (`accounts`, `systemDefault: { email, providerAccountId, workspaceLabel }`).
 * System default is the login with the same email and provider account (or, without one, the same
 * workspace).
 */
export function projectCodex(block: unknown): DiscoveredAccount[] {
  if (!isObject(block) || !Array.isArray(block.accounts)) throw new Error('Orca returned no Codex account list')
  const host = block.accounts.filter((a): a is Record<string, unknown> => isObject(a) && !!text(a.id) && !!text(a.email) && (a.managedHomeRuntime ?? 'host') === 'host')
  const seen = new Set<string>()
  const unique = host.filter((a) => !seen.has(a.id as string) && !!seen.add(a.id as string))
  const sd = isObject(block.systemDefault) && block.systemDefault.hasAuth !== false ? block.systemDefault : null
  const sdEmail = lower(sd?.email)
  const sdAccount = text(sd?.providerAccountId)
  const alias = sdEmail
    ? onlyMatch(unique, (a) => lower(a.email) === sdEmail && (sdAccount ? text(a.providerAccountId) === sdAccount : (text(a.workspaceLabel) ?? null) === (text(sd?.workspaceLabel) ?? null)))
    : null
  return unique.map((a) => ({
    id: a.id as string,
    label: labelOf(text(a.email)!, a.displayName),
    organization: text(a.workspaceLabel),
    systemDefault: a === alias,
    needsSignIn: a.needsSignIn === true
  }))
}

/** A short reason for the page: one line, no paths. */
export function readFailure(provider: SwitchProvider, e: unknown): string {
  const msg = String((e as Error)?.message ?? e).split('\n')[0].replace(/(?:\/[\w.@-]+){2,}/g, '…').trim()
  if (/unknown (?:flag|option)|unsupported|not a command|unknown command/i.test(msg)) return `This Orca can’t list ${PROVIDER_NAME[provider]} accounts. Update Orca to see them here.`
  if (/ENOENT|not found|spawn/i.test(msg)) return 'Orca’s command line isn’t available, so accounts can’t be listed.'
  if (/timed out/i.test(msg)) return `Orca took too long to list ${PROVIDER_NAME[provider]} accounts.`
  return `Couldn’t read ${PROVIDER_NAME[provider]} accounts${msg ? `: ${msg.slice(0, 140)}` : '.'}`
}

const PROJECT: Record<SwitchProvider, (block: unknown) => DiscoveredAccount[]> = { claude: projectClaude, codex: projectCodex }

/** Both providers' logins, read now; one failing never hides the other. */
export async function discoverAccounts(run: Run): Promise<AccountsState> {
  const read = async (p: SwitchProvider): Promise<ProviderAccounts> => {
    try {
      return { accounts: PROJECT[p](await run(['account', 'list', '--agent', p], { timeoutMs: 10_000 })), error: null }
    } catch (e) {
      return { accounts: [], error: readFailure(p, e) }
    }
  }
  const [claude, codex] = await Promise.all(SWITCH_PROVIDERS.map(read))
  return { claude, codex, enforcement: ENFORCEMENT }
}

/** The workspace Settings was opened in: what its overrides are saved under, and its name for the page. */
export type WorkspaceRef = { id: string; name: string }

/**
 * The workspace focused in Orca, from the panel's snapshot: the one focused row (several agents of a
 * workspace share its id), else the focused coordinator's folder workspace. None, or two different
 * focused workspaces, is null: then nothing is edited, since a guess could change another workspace.
 */
export function currentWorkspace(snap: {
  rows: { id: string; name: string; active: boolean; historical?: boolean }[]
  coordinators: { name: string; workspaceId: string | null; active?: boolean }[]
} | null | undefined): WorkspaceRef | null {
  if (!snap) return null
  const rows = snap.rows.filter((r) => r.active && !r.historical && r.id.trim())
  const ids = new Set(rows.map((r) => r.id))
  if (ids.size === 1) return { id: rows[0].id, name: rows[0].name || rows[0].id }
  if (ids.size > 1) return null
  const coords = snap.coordinators.filter((c) => c.active && c.workspaceId)
  return coords.length === 1 ? { id: coords[0].workspaceId!, name: coords[0].name } : null
}
