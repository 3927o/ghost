/** Retry committed notifications; Redis job IDs deduplicate an ambiguous acknowledgement. */
interface OutboxStore { pending(): Promise<string[]>; acknowledge(id: string): Promise<void> }
/** Application port; the composition root adapts the generic transport to run notifications. */
interface RunPublisher { publish(runId: string): Promise<void> }

export class OutboxDispatcher {
  private readonly outbox: OutboxStore
  private readonly publisher: RunPublisher
  private readonly reportError: (error: unknown) => void
  private timer?: NodeJS.Timeout
  private pending?: Promise<void>
  private stopping = false
  private failed = false

  constructor(outbox: OutboxStore, publisher: RunPublisher, reportError = console.error) {
    this.outbox = outbox
    this.publisher = publisher
    this.reportError = reportError
  }

  start(): void {
    void this.flush()
    this.timer ??= setInterval(() => void this.flush(), 250)
  }

  flush(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    return this.pending ??= this.deliver().finally(() => { this.pending = undefined })
  }

  private async deliver(): Promise<void> {
    try {
      for (const runId of await this.outbox.pending()) {
        if (this.stopping) break
        await this.publisher.publish(runId)
        await this.outbox.acknowledge(runId)
      }
      this.failed = false
    } catch (error) {
      if (!this.failed) this.reportError(error)
      this.failed = true
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    await this.pending
  }
}
