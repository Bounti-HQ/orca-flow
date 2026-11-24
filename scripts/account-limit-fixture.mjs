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
