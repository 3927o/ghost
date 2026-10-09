/**
 * Agent Core: Cordis + DSH wrapper
 * Exposes a clean interface to the application layer.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionStore, type Session } from '@deepseek-ai/dsh-session'

export interface RunTurnParams {
  agent: Agent
  message: string
  onEvent?: (event: SessionEvent) => void
  onText?: (text: string) => void
}

export interface TurnResult {
  sessionId: string
  events: SessionEvent[]
}

export interface AgentCoreConfig {
  dshHome: string
  skillsDir: string
  modelProvider: string
  modelName: string
  sessionDbPath: string
}

export class AgentCore {
  private ctx!: Context
  private agents!: AgentRegistry
  private sessions!: SessionStore
  private persistence!: SessionPersistence
  private config: AgentCoreConfig

  constructor(config: AgentCoreConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    // Set environment variables before boot
    process.env.DSH_HOME = this.config.dshHome
    process.env.AGENT_SKILLS_DIR = this.config.skillsDir
    process.env.SESSION_DB_PATH = this.config.sessionDbPath

    const coreYaml = join(import.meta.dirname, 'cordis-core.yml')
    if (!existsSync(coreYaml)) {
      throw new Error(`cordis-core.yml not found at ${coreYaml}`)
    }

    this.ctx = await boot('ghost-core', coreYaml)
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const persistence = this.ctx.get('sessionPersistence')
    if (!agents || !sessions || !persistence) {
      throw new Error('agents, sessions or sessionPersistence service not available from DSH')
    }
    this.agents = agents
    this.sessions = sessions
    this.persistence = persistence

    console.log('[AgentCore] Initialized')
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return !!await this.persistence.stat(SessionId(sessionId))
  }

  create(sessionId: string): Promise<AgentHandle> {
    return this.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: this.config.modelProvider, model: this.config.modelName },
    })
  }

  resume(sessionId: string): Promise<AgentHandle> {
    return this.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: this.config.modelProvider, model: this.config.modelName },
    })
  }

  /** Read durable events; the application decides how to present them. */
  async readSession(sessionId: string): Promise<{ createdAt: number; events: readonly SessionEvent[] }> {
    const id = SessionId(sessionId)
    const agent = this.agents.get(id)
    if (agent) {
      await agent.whenIdle()
      await this.sessions.flush(agent.session)
    }
    const handle = await this.persistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      return { createdAt: handle.header.createdAt, events }
    } finally {
      await handle.close()
    }
  }

  /** The caller serializes work for this Agent to keep callbacks scoped to one turn. */
  async runTurn(params: RunTurnParams): Promise<TurnResult> {
    const { agent, message, onEvent, onText } = params
    await agent.whenIdle()

    // Subscribe only after previous work has finished.
    const events: SessionEvent[] = []

    // Listen to session events through the context
    const eventListener = (session: Session, event: SessionEvent) => {
      // Match by session object reference
      if (session === agent.session) {
        events.push(event)
        onEvent?.(event)
      }
    }

    const dispose = this.ctx.on('session/event', eventListener)
    let textAssembler = new BlockAssembler()
    let lastText = ''
    const disposeStream = onText && this.ctx.on('agent/assistant-stream', ({ agent: sourceAgent, frame }) => {
      if (sourceAgent !== agent) return

      if (frame.type === 'start') {
        textAssembler = new BlockAssembler()
        lastText = ''
        onText('')
      } else if (frame.type === 'chunk') {
        const { chunk } = frame
        // Assemble text blocks only; reasoning and tool arguments stay out of chat.
        if (chunk.type !== 'text-delta'
          && !(chunk.type === 'block-start' && chunk.blockType === 'text')
          && !(chunk.type === 'block-end' && chunk.block.type === 'text')) return

        textAssembler.push(chunk)
        const text = textAssembler.blocks()
          .filter(block => block.type === 'text')
          .map(block => block.text).join('')
        if (text !== lastText) {
          lastText = text
          onText(text)
        }
      }
    })

    try {
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      })

      agent.followup(userMessage)
      // Persist accepted input even if the process stops during generation.
      await this.sessions.flush(agent.session)
      await agent.whenIdle()
      await this.sessions.flush(agent.session)

      const turnEnd = events.findLast(event => event.type === 'turn/end')
      if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error') {
        throw new Error('Agent turn failed', { cause: turnEnd.data.reason.error })
      }

      return {
        sessionId: agent.id,
        events,
      }
    } catch (error) {
      console.error(`[AgentCore] Error during runTurn:`, error)
      throw error
    } finally {
      disposeStream?.()
      dispose()
    }
  }

  async dispose(): Promise<void> {
    await this.ctx.fiber.dispose()
    console.log('[AgentCore] Disposed')
  }
}
