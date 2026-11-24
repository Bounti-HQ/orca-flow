# Continuing work after a Claude or Codex account limit

**On macOS with Orca 1.4.272, the supported recovery for supervised work is to continue in the
original conversation after reset.** Flow cannot select a different managed account for just that
assignment. A person can use Orca's own switcher when a change to the provider default on that
host is intended.

The proposed primary trigger is earlier than a limit: these accounts go on to paid usage once their
included usage reaches 100%, until an account or team spending cap. Flow should move work to a login
that still has included usage before the next paid request. Orca 1.4.272 cannot do this. Its own
reading counts paid credits as room (see [Included usage before paid usage](#included-usage-before-paid-usage)).

## Recover on this host

| Where the limit appeared | What to do |
| --- | --- |
| Native Claude or Codex chat | Read the usage-limit row for the interrupted turn. If it says Orca will continue at a given time, leave that continuation to Orca. Otherwise use **Continue** once available. An unknown reset may require a manual check. |
| Coordinator, lead or worker in a terminal | Keep the original pane open. After capacity returns, check what the interrupted turn already completed and continue once in that pane. Keep the assigned run, dispatch, pending questions and gates in place. Verify any tool action whose result is uncertain before repeating it. |
| All eligible accounts are exhausted, share the exhausted allowance, or its scope is unknown | Wait for the displayed reset or for the provider to confirm capacity. A transient retry or HTTP 429 alone gives no reason to change accounts. |

If ownership is unclear, use **Copy Orca Session ID** and `orca agent show <orca_session_id:…> --json`
to inspect the conversation's locations. Zero or multiple locations require reconciliation before
sending a continuation. A coordinator can inspect `orca orchestration run-show --id <run> --full`,
`orca orchestration inbox --terminal run:<run>` and `orca orchestration gate-list --run <run> --status pending`.
For a lead or worker, `orca orchestration worker-show --dispatch <dispatch> --full` identifies the
existing assignment. Silence or an unknown process state does not establish that it stopped.

### Manual account controls

For an independent conversation whose context both accounts may receive, a user can intentionally
select a new provider default. In **Settings → AI Provider Accounts**, check Claude's running-terminal
preference first. **Ask** lets the user review which terminal conversations to restart. Restarting
a busy one stops its current work. Eligible native Claude chats also expose **Switch account** on
the usage-limit row. This checks the chat's eligibility and then calls the host account selector.
For an eligible Codex terminal showing **Account switched**, **Restart** applies the new selection
to that pane and **Keep old account** keeps it on the previous one.

These controls supply no proof that a restarted process retains a supervised dispatch or every
run binding. Use the original-conversation recovery for active supervised work. Flow has no
automatic select/launch/restore sequence, account-home override or credential migration.

### How the account picker keeps a terminal conversation

The Claude account row in the **Usage** menu calls the desktop account selector with the chosen
account and runtime. Orca then queues the eligible terminal panes selected for restart. The queue
stores a pane's PTY ID and provider. It carries no independent destination account ID.

For a resumable terminal, Orca reads that pane's recorded provider session and launch settings.
The resume command is `claude --resume <session-id>` or `codex resume <session-id>` (with
applicable launch options). Orca restarts the process in the same pane and worktree. The provider
session ID gives the user their conversation back. Claude checks whether the same session is open
in another pane before resuming it. Codex can fall back to a fresh process when it cannot build
a resume command, so clicking **Restart** by itself is insufficient proof of continuity.

Reuse this host implementation for automatic switching. Expose the existing pane restart through a
supported CLI or plugin operation that takes the destination account as part of the same request,
requires exact-session resume, and confirms the resulting account and owner. On 1.4.272 Flow's
public `agent.resume` accepts only workspace, provider and session. Calling it after a host-wide
account change also changes which account unrelated launches use.

The installed implementation can be traced from `runtime-provider-accounts-client` (selection),
through `queuePaneAccountRestarts` and the renderer's `resumeProviderSession` construction, to
`shared/agent-launch/startup/agent-resume-argv.js` (provider commands). The detached-pane path in
the desktop renderer uses `replacesPtyId` while keeping the worktree, tab and leaf IDs.

## Included usage before paid usage

**Proposed, not available on 1.4.272.** When a fresh, attributable provider reading shows 100% or more
of an included window that applies to this conversation's model and login, the host selects an
eligible same-provider login with confirmed included usage before the next billable request. It does
this even though the current account can still pay and no error has appeared.

- **What counts.** A reading taken recently enough for this request, attributed to the source login,
  for a window that covers its model. A meter that rounds 99.6% to 100%, a stale or unknown reading, a
  window for another model and a temporary retry or HTTP 429 are not proof. They leave the work where
  it is.
- **Who may receive it.** The same eligibility as every switch: inside the workspace's authorized
  sharing scope, not covered by the same organization or team window, aliases such as System default
  collapsed, able to run the chosen model and effort, and with a fresh reading showing included usage
  left. A login whose usage is unknown is not a destination.
- **When none has any.** Pause before the next paid request. Show the earliest known reset, or that
  it is unknown, with **Check now**. Don't cycle through logins.
- **Fallback.** A hard usage-limit error still triggers the same continuation when the reading was
  missed or unavailable.
- **Boundary.** Only the host can enforce this. It must check at the provider-request boundary and
  own the targeted continuation. Background readings and Flow's UI are not spend caps. A request
  already in flight can still cost paid usage, so there is no guarantee of zero paid usage. Spending
  caps stay with the provider account or team.

The sidebar stays as it is. Moving shows on the row as the panel's pending status ("Moving to …"), a
completed move as one faint account label, and a pause as the row's warn status plus one line under
Coordinators. There is no usage or cost dashboard and no setup decision. The **Account switching**
page in Settings, beside Models, says that every eligible login is used by default at 100% included
usage, and holds the off switch and per-login exclusions. Off means Flow doesn't step in, so the
provider goes on to paid usage.

## Installed-host evidence

Checked on 2026-11-24 using the installed CLI, generated plugin types and bundled contracts.

| Surface | Evidence | Consequence |
| --- | --- | --- |
| Accounts | `orca account list --help` and `orca account select --help` describe selection for future launches on this host. A runtime lane such as a WSL distribution also covers many launches. | A host default or shared email cannot identify the account that owns an existing conversation. |
| Launch and resume | `orca agent-context --json` lists the flags for `agent launch`, `worktree create` and `orchestration worker-start`. None accepts a managed account ID. The worker types generated by `orca plugin types` give `agent.launch` a workspace, agent and optional prompt, and `agent.resume` a workspace, agent and session ID. | No supported target-account argument or effective-account receipt. Replay IDs deduplicate requests but cannot bind them to an account. |
| Internal launch environment | Bundled `shared/rpc-contract/agent-launch/agent-launch-params.js` documents `accountEnv` as desktop-prepared WSL terminal routing, outside replay identity. Structured launches keep their host account. | This field cannot provide targeted managed-account continuation. |
| Limit signal | The public `agent.status.changed` event gives pane, session, state and optional turn outcome. Native chat separately distinguishes `usageLimitReached` from `providerRetrying`, which can carry HTTP 429. | Flow lacks a public event proving the interrupted turn, affected account and quota scope together. Transcript text and usage meters cannot authorize a transfer. |
| Included usage | Installed `shared/agent-usage/rate-limits/rate-limit-spent-windows.js` (SHA-256 `5eed6448…63d32e2`), given a synthetic reading with the session window at 100% and paid credits enabled with a positive balance: `rateLimitShowsRoom` returns true and `rateLimitSpentUntil` returns undefined. Without paid usage, or with it spent, the same reading is spent until its reset. A 99.6% reading is room. | On 1.4.272 a login at 100% included usage with paid credits left reads as available, so nothing in the host stops it going on to paid usage. This is narrow evidence about one pure function, not about billing or every reader. |
| Coordinator transfer | The multi-run handover fixture on 1.4.272 moved two runs to **two separate receivers**. It observed unread mail, subsequent worker reports and pending gates. A receiver's `run-use` releases its other bindings. | Adopting multiple runs successively in one replacement would lose earlier bindings. Moving a run cannot transfer a worker dispatch or a lead's parent assignment. |

The installed renderer's native chat usage-limit actions, Claude switcher and restart dialog,
and Codex restart chip supply the manual control evidence. The multi-run evidence is in
`git show 1321f9d:docs/coordinator-handover.md` and its disposable `scripts/handover-fixture.mjs`.

Run `node scripts/account-limit-fixture.mjs` on this build to exercise the installed native chat
journal readers with synthetic turns. A confirmed limit with a known reset is eligible for scheduling.
A transient retry, a child agent's limit, a different turn's schedule, a newer request or a pending
submission cannot authorize continuation of the original turn. An unknown reset alone cannot
schedule it. The fixture exercises the recovery decision. It makes no provider calls or live sends.
The same script also checks the included-usage reading above with synthetic readings.
A live cross-account task continuation, the desktop restart controls, real usage readings and billing
were not exercised.

## Contract for automatic substitution

1. **Use every eligible account by default.** When the host supports targeted continuation, switching
   is on with no setup, prompt or picker. Candidates are all automatically discovered managed logins
   of the same provider on the same execution host, with System default and other aliases collapsed
   onto the one login they point to. A candidate is eligible only inside the workspace's already
   authorized context-sharing scope, as Orca reports it for both the workspace and the login.
   Discovering a login, or its email, label, shared host or organization name, does not establish
   that scope. Defaulting to all never sends private work to an unrelated identity. When Orca cannot
   establish the scope, leave the work in place and say why. Reauthentication under a different
   identity makes a login a new candidate that has to be checked again. Offer a quiet override,
   reached only when the user looks for it, to exclude logins or turn switching off. It lives on its
   own **Account switching** Settings page. Healthy work shows no account chrome. A successful switch
   leaves one inline record.
   `docs/account-failover-prototype.html` previews this in the released Orca Flow 0.2.98 panel with
   synthetic data (`node scripts/account-failover-preview.mjs` rebuilds it).
2. **Require a confirmed trigger.** The primary trigger is a fresh, attributable reading at 100% or
   more of an included window that applies to the conversation's model and login, checked by the host
   before the next billable request. The fallback is a hard usage-limit error. Orca supplies a stable
   event ID, exact source session, turn, account, owner generation and scope of the spent allowance.
   A rounded display, a stale or unknown reading, another model's window and a transient retry are not
   triggers. Exclude every candidate covered by the same organization or team window, and every
   candidate without a fresh reading showing included usage left. Unknown scope pauses before paid
   usage and says why. Keep the chosen model and effort. A candidate that cannot run them
   is ineligible for this incident.
3. **Continue once.** Prefer a host operation that changes the account in the original session.
   Bind the target account, source checkpoint, expected owner generation and idempotency key in
   the same operation. Fence the source before the target acts. Verify the destination before
   releasing context. Coordinate native reset timers and pending sends so only one continuation
   can win. Reconcile ambiguous replies by operation ID and uncertain tool effects before replay.
4. **Preserve the assignment.** Require an effective account receipt plus session continuity,
   workspace, role, model and owner. Coordinators keep all their run consumers and mailboxes.
   Workers keep their dispatch and parent reply route. Leads keep both their parent assignment
   and their children, including unanswered questions and gates. A replacement session requires
   an atomic transfer of these bindings or refusal before releasing the source.
5. **Bound retries.** Persist the source and attempted identities per incident, including known reset
   times. Try each eligible identity at most once. Duplicate events, concurrent observers and plugin
   restarts reconcile the same incident. When no eligible login has included usage, pause before the
   next paid request and show one actionable waiting line with the earliest known reset, without
   cycling through accounts. Recheck capacity on a fresh host signal
   or explicit user retry.
   Store opaque IDs and recovery metadata in Flow. Orca owns authentication and context migration.
