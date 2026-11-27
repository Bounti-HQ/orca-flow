// Offline check of Orca's native chat recovery decision. Run with node on the installed macOS host.
// Imports the installed pure journal readers only. All turns, limits and submissions are synthetic.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const requireHost = createRequire('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/native-chat/transcript/continuation/fixture.cjs')
const { latestNativeChatUsageLimitCut, isNativeChatUsageLimitCutSchedulable } = requireHost('./native-chat-usage-limit-cut.js')
const { usageLimitContinueStateForCut } = requireHost('./native-chat-usage-limit-auto-continue.js')

const turn = { itemId: 'original-turn', body: { kind: 'turn', state: 'completed', outcome: 'failure', completedAt: 1000 } }
const limit = {
  itemId: 'limit', turnScope: { kind: 'turn', turnItemId: turn.itemId },
  body: { kind: 'status', failure: { kind: 'usageLimitReached', usageLimit: { window: 'weekly', resetsAt: 5000 } } }
}
const cut = latestNativeChatUsageLimitCut([turn, limit], [])
assert.deepEqual(cut, { turnItemId: turn.itemId, turnEndedAt: 1000, resetsAt: 5000 })
assert.equal(isNativeChatUsageLimitCutSchedulable(cut, 4000), true)
const scheduled = { turnItemId: turn.itemId, resetsAt: 5000, state: 'scheduled' }
assert.equal(usageLimitContinueStateForCut(scheduled, cut), 'scheduled')
assert.equal(usageLimitContinueStateForCut({ ...scheduled, turnItemId: 'earlier-turn' }, cut), undefined)

const retry = { ...limit, body: { kind: 'status', failure: { kind: 'providerRetrying', retry: { status: 429 } } } }
assert.equal(latestNativeChatUsageLimitCut([turn, retry], []), null)
assert.equal(latestNativeChatUsageLimitCut([turn, { ...limit, agentId: 'child-agent' }], []), null)
assert.equal(latestNativeChatUsageLimitCut([turn, limit], [{ dispatchState: 'pending' }]), null)
const nextRequest = { itemId: 'new-request', body: { kind: 'message', role: 'user', blocks: [] } }
assert.equal(latestNativeChatUsageLimitCut([turn, limit, nextRequest], []), null)
const noReset = { ...limit, body: { kind: 'status', failure: { kind: 'usageLimitReached' } } }
assert.equal(isNativeChatUsageLimitCutSchedulable(latestNativeChatUsageLimitCut([turn, noReset], []), 4000), false)
console.log('Verified the installed host’s reset decision for a limited turn, a retry, a child, a newer request, a pending send and an unknown reset.')
// Included usage at 100% with paid usage left. Synthetic readings only: no account is read, no request is sent.
const requireUsage = createRequire('/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared/agent-usage/rate-limits/fixture.cjs')
const { rateLimitShowsRoom, rateLimitSpentUntil } = requireUsage('./rate-limit-spent-windows.js')
const resetsAt = 7_200_000
const window = (usedPercent) => ({ usedPercent, resetsAt, windowMinutes: 300 })
const reading = (session, extraUsage = null) => ({ session: window(session), weekly: window(40), extraUsage })
const credits = { enabled: true, unit: 'credits', unlimited: false, balance: 5 }
// The narrow evidence: at 100% included with a positive paid-credit balance, the host reads room and no spent window.
assert.equal(rateLimitShowsRoom(reading(100, credits)), true)
assert.equal(rateLimitSpentUntil(reading(100, credits)), undefined)
// Without paid usage, or with it spent, the same 100% reading is spent until its reset.
assert.equal(rateLimitShowsRoom(reading(100)), false)
assert.equal(rateLimitSpentUntil(reading(100)), resetsAt)
assert.equal(rateLimitSpentUntil(reading(100, { enabled: true, unit: 'usd', spentPercent: 100, balance: 0 })), resetsAt)
// A 99.6% reading, which a meter can show as 100, is room.
assert.equal(rateLimitShowsRoom(reading(99.6)), true)
console.log('Verified that the installed reading treats 100% included usage with paid credits left as room, which is where a paid continuation starts.')
