/** Redis/BullMQ transport. No business-database or Agent-runtime dependency. */
import { DelayedError, Queue, Worker, type RedisOptions, type JobsOptions } from 'bullmq'
import { Redis } from 'ioredis'

export interface RedisQueueConfig { url: string; queueName: string }
export interface QueueJob<T> { id: string; name: string; data: T }
export interface JobHandler<T> {
  execute(job: QueueJob<T>, signal: AbortSignal): Promise<'done' | 'defer'>
  deliveryFailed(job: QueueJob<T>, error: Error): void | Promise<void>
}
export type DeliveryOptions = Pick<JobsOptions, 'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail'>
export interface ConsumerOptions {
  concurrency?: number
  lockDuration?: number
  deferDelayMs?: number
  maxStalledCount?: number
}

function connection(config: RedisQueueConfig, consumer: boolean): RedisOptions {
  const url = new URL(config.url)
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://')
  return {
    host: url.hostname, port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: consumer ? null : 1,
    enableOfflineQueue: consumer,
    connectTimeout: 2000,
    retryStrategy: attempt => Math.min(attempt * 100, 2000),
    ...(consumer ? {} : { commandTimeout: 2000 }),
  }
}

export class RedisQueue<T> {
  private queue?: Queue<T, void, string, T, void, string>
  private readonly redis: Redis
  private readonly config: RedisQueueConfig
  private readonly deliveryOptions: DeliveryOptions

  constructor(config: RedisQueueConfig, deliveryOptions: DeliveryOptions = {}) {
    this.config = config
    this.deliveryOptions = deliveryOptions
    this.redis = new Redis(connection(config, false))
    // Callers receive delivery errors from publish() and decide whether to retry.
    this.redis.on('error', () => {})
  }

  private createQueue(): Queue<T, void, string, T, void, string> {
    const queue = new Queue<T, void, string, T, void, string>(this.config.queueName, {
      connection: this.redis,
      defaultJobOptions: this.deliveryOptions,
    })
    // Redis emits connection errors separately; publish() owns their delivery outcome.
    queue.on('error', () => {})
    return queue
  }

  async publish(id: string, name: string, data: T): Promise<void> {
    if (this.redis.status !== 'ready') throw new Error('Redis is unavailable')
    const queue = this.queue ??= this.createQueue()
    try {
      await queue.add(name, data, { jobId: id })
    } catch (error) {
      // A failed initialization promise is not reusable after Redis reconnects.
      if (this.queue === queue) this.queue = undefined
      await queue.close().catch(() => {})
      throw error
    }
  }

  async close(): Promise<void> {
    try { await this.queue?.close() } finally { this.redis.disconnect() }
  }
}

export class QueueWorker<T> {
  private readonly worker: Worker<T>
  private readonly active = new Map<string, AbortController>()
  private readonly stopping = new AbortController()
  private readonly failures = new Set<Promise<void>>()

  constructor(config: RedisQueueConfig, handler: JobHandler<T>, options: ConsumerOptions = {}) {
    const { lockDuration = 30_000, concurrency = 1, deferDelayMs = 250, maxStalledCount = 1 } = options
    if (!Number.isFinite(lockDuration) || lockDuration < 1000) throw new Error('lockDuration must be at least 1000ms')
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
    this.worker = new Worker<T>(config.queueName, async (job, token) => {
      const controller = new AbortController()
      this.active.set(job.id!, controller)
      try {
        const signal = AbortSignal.any([this.stopping.signal, controller.signal])
        const result = signal.aborted ? 'defer' : await handler.execute({ id: job.id!, name: job.name, data: job.data }, signal)
        if (result === 'defer') {
          await job.moveToDelayed(Date.now() + deferDelayMs, token)
          throw new DelayedError()
        }
      } finally {
        this.active.delete(job.id!)
      }
    }, {
      connection: connection(config, true), autorun: false, concurrency,
      lockDuration, stalledInterval: Math.min(lockDuration, 5000), maxStalledCount,
    })
    this.worker.on('lockRenewalFailed', ids => {
      for (const id of ids) this.active.get(id)?.abort(new Error('Redis job ownership lost'))
    })
    this.worker.on('error', error => {
      for (const controller of this.active.values()) controller.abort(error)
      console.error('[QueueWorker]', error.message)
    })
    this.worker.on('failed', (job, error) => {
      if (job && (job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === 'UnrecoverableError')) {
        const pending = Promise.resolve().then(() => handler.deliveryFailed({ id: job.id!, name: job.name, data: job.data }, error)).catch(failure => { console.error('[QueueWorker]', failure) })
        this.failures.add(pending)
        void pending.finally(() => this.failures.delete(pending))
      }
    })
  }

  async ready(): Promise<void> { await this.worker.waitUntilReady() }
  async start(): Promise<void> { await this.worker.run() }

  async stop(): Promise<void> {
    this.stopping.abort(new Error('Worker shutting down'))
    await this.worker.close()
    await Promise.all([...this.failures])
  }
}
