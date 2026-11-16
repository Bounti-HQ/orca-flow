// Holds the panel's redraws while a pointer is pressed. A redraw replaces the rows' HTML; if it
// lands between pointerdown and pointerup, the pressed row is gone and Chromium sends no click at
// all, so the click is lost. Snapshots arrive every few seconds (summaries, status changes, memory),
// often enough to hit a press now and then.

type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }

/**
 * `draw()` paints now, or once the press ends when a pointer is down. `up()` flushes on the next
 * tick, after the click that follows pointerup has run. A press held longer than `maxHoldMs` (a drag,
 * a release outside the panel) flushes anyway, so the panel never stays stale.
 */
export function pressGate(paint: () => void, options: { maxHoldMs?: number; timers?: Timers } = {}) {
  const timers = options.timers ?? realTimers
  let pressed = false
  let wanted = false
  let safety: unknown = null
  const flush = () => {
    pressed = false
    if (safety !== null) timers.clear(safety)
    safety = null
    if (wanted) {
      wanted = false
      paint()
    }
  }
  return {
    draw(): void {
      if (pressed) wanted = true
      else paint()
    },
    down(): void {
      pressed = true
      if (safety !== null) timers.clear(safety)
      safety = timers.set(flush, options.maxHoldMs ?? 3000)
    },
    up(): void {
      if (pressed) timers.set(flush, 0)
    },
    get held(): boolean {
      return pressed && wanted
    }
  }
}
