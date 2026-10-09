/** DSH lifecycle and event-to-text projection, owned exclusively by the Worker. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionStore } from '@deepseek-ai/dsh-session'
import type { AgentExecutor, AgentExecution } from '@ghost/contracts'

export interface AgentCoreConfig {
  dshHome: string
  skillsDir: string
  modelProvider: string
  modelName: string
  sessionDatabase: { type: 'sqlite'; path: string } | { type: 'postgres' | 'mysql'; url: string; poolSize?: number }
}

export class AgentCore implements AgentExecutor {
  private ctx!: Context
  private agents!: AgentRegistry
  private sessions!: SessionStore
  private persistence!: SessionPersistence
  private readonly config: AgentCoreConfig

  constructor(config: AgentCoreConfig) { this.config = config }

  async init(): Promise<void> {
    process.env.DSH_HOME = this.config.dshHome
    process.env.AGENT_SKILLS_DIR = this.config.skillsDir
    process.env.AGENT_DATABASE_CONFIG = JSON.stringify(this.config.sessionDatabase)
    process.env.AGENT_DATABASE_PROVIDER = this.config.sessionDatabase.type === 'postgres' ? 'pg' : this.config.sessionDatabase.type
    this.ctx = await boot('ghost-worker', join(import.meta.dirname, 'cordis-core.yml'))
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    if (!agents || !sessions || !persistence) throw new Error('DSH runtime services unavailable')
    this.agents = agents
    this.sessions = sessions
    this.persistence = persistence
  }

  async execute(run: AgentExecution, signal: AbortSignal, onText: (text: string) => void): Promise<string> {
    signal.throwIfAborted()
    const id = SessionId(run.sessionId)
    const agentOptions = { provider: this.config.modelProvider, model: this.config.modelName }
    const persisted = await this.persistence.stat(id)
    const handle: AgentHandle = persisted
      ? await this.agents.resume({ resumeSessionId: id, agentOptions })
      : await this.agents.create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions })
    const agent = handle.agent
    const cancel = () => agent.cancel({ kind: 'hook', reason: 'Worker execution cancelled' })
    signal.addEventListener('abort', cancel, { once: true })
    let text = ''
    let assembler = new BlockAssembler()
    let turnEnd: Extract<SessionEvent, { type: 'turn/end' }> | undefined
    const publish = (value: string) => { text = value; onText(value) }
    const removeEvent = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/end') turnEnd = event
      if (event.type === 'assistant/message') {
        publish(event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      }
    })
    const removeStream = this.ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source !== agent) return
      if (frame.type === 'start') {
        assembler = new BlockAssembler()
        publish('')
      } else if (frame.type === 'chunk') {
        const { chunk } = frame
        if (chunk.type !== 'text-delta'
          && !(chunk.type === 'block-start' && chunk.blockType === 'text')
          && !(chunk.type === 'block-end' && chunk.block.type === 'text')) return
        assembler.push(chunk)
        const value = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
        if (value !== text) publish(value)
      }
    })
    try {
      signal.throwIfAborted()
      await agent.whenIdle()
      signal.throwIfAborted()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: run.input }], source: { kind: 'user' } }))
      await this.sessions.flush(agent.session)
      await agent.whenIdle()
      await this.sessions.flush(agent.session)
      signal.throwIfAborted()
      if (turnEnd?.data.reason.kind !== 'completed') {
        throw new Error(`Agent turn did not complete: ${turnEnd?.data.reason.kind ?? 'missing turn/end'}`)
      }
      return text
    } finally {
      signal.removeEventListener('abort', cancel)
      removeEvent()
      removeStream()
      // Release the DSH writer before another Worker can claim this conversation's next run.
      await handle.dispose()
    }
  }

  async dispose(): Promise<void> { await this.ctx?.fiber.dispose() }
}
