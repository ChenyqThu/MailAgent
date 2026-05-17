// Tiny FIFO semaphore for CliQueue read/write lane gating.
// Stays minimal on purpose: 30 lines beats pulling in `async-sema`/`p-queue`
// for a single use site (BACKEND-INTERFACES.md §1.6).

export class Semaphore {
  private permits: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`)
    }
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Hand the permit straight to the next waiter — no transient increment so
      // a competing acquire() called between shift() and the resolve callback
      // can't sneak past the queue head.
      next()
      return
    }
    this.permits++
  }

  get available(): number {
    return this.permits
  }

  get waiting(): number {
    return this.waiters.length
  }
}
