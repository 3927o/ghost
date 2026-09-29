/**
 * 最小嵌入示例：在宿主进程里用 boot() 起一棵精简的 dsh 插件树，
 * 自己创建 agent、投递一条用户消息、等这一轮跑完，并打印 session 事件流。
 *
 * 运行（项目根目录，Node >= 24 可直接跑 .ts）：
 *   npm start -- ["你的问题"]
 *
 * 模型配置读 .env：MODEL_API_BASE_URL、MODEL_API_KEY、MODEL_NAME。
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {} from '@deepseek-ai/dsh-agent'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, expandAssistantStream, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

const rootDir = dirname(fileURLToPath(import.meta.url))

const envFile = join(rootDir, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const model = process.env.MODEL_NAME
if (process.env.MODEL_API_BASE_URL === undefined || process.env.MODEL_API_KEY === undefined || model === undefined) {
  throw new Error('MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_NAME must be set (see .env)')
}

// boot() 之前设置：DSH_HOME 决定 session 日志落在哪；AGENT_SKILLS_DIR 被 cordis.yml 的 !!js 读取。
const dshHome = (process.env.DSH_HOME ??= join(rootDir, '.dsh-home'))
process.env.AGENT_SKILLS_DIR = join(rootDir, 'skills')

const ctx = await boot('ghost', join(rootDir, 'cordis.yml'))

const startedAt = Date.now()
const stepStartedAt = new Map<string, number>()
const usageByStep = new Map<string, TokenUsage>()
let answer = ''

function preview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function describe(event: SessionEvent): string | undefined {
  switch (event.type) {
    case 'request/header': {
      const { provider, model } = event.data.header.config
      return `${provider}/${model} tools=${event.data.header.tools?.length ?? 0}`
    }
    case 'step/start':
      stepStartedAt.set(`${event.data.turn}/${event.data.step}`, event.time)
      return `turn=${event.data.turn} step=${event.data.step}`
    case 'assistant/message': {
      const key = `${event.data.turn}/${event.data.step}`
      // 流里每个 chunk 都带 epoch 毫秒时间戳；首 chunk 减 step 开始时间即首包延迟。
      const chunks = expandAssistantStream(event.data.stream)
      const stepStart = stepStartedAt.get(key)
      const ttft = chunks[0] === undefined || stepStart === undefined ? '?' : `${chunks[0].time - stepStart}ms`
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text !== '') answer = text
      if (event.data.usage !== undefined) usageByStep.set(key, event.data.usage)
      const usage = event.data.usage === undefined ? '' : ` usage=${JSON.stringify(event.data.usage)}`
      return `chunks=${chunks.length} ttft=${ttft}${usage} text="${preview(text)}"`
    }
    case 'tool/call':
      return `${event.data.name}(${preview(event.data.arguments)})`
    case 'tool/result':
      return `isError=${event.data.message.isError === true}`
    case 'turn/end': {
      const { reason } = event.data
      return reason.kind === 'error' ? `reason=error ${preview(JSON.stringify(reason.error), 300)}` : `reason=${reason.kind}`
    }
    default:
      return undefined
  }
}

// 所有 session 事件都会经过这里；这就是后续 trace 插件要订阅的同一条流。
ctx.on('session/event', (_session, event) => {
  const detail = describe(event)
  const at = String(event.time - startedAt).padStart(6)
  console.log(`[${at}ms] ${event.type.padEnd(22)}${detail === undefined ? '' : ` ${detail}`}`)
})

const agents = ctx.get('agents')
const sessions = ctx.get('sessions')
if (agents === undefined || sessions === undefined) throw new Error('agents/sessions service missing')

const sessionId = SessionId(`ghost-${randomUUID()}`)
const { agent, dispose } = await agents.create({
  sessionId,
  meta: { cwd: process.cwd() },
  agentOptions: { provider: 'deepseek-official', model },
})

try {
  const task = process.argv[2] ?? '用 greeting 技能跟我打个招呼，我叫 Richard。'
  await agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const total = [...usageByStep.values()].reduce(
    (sum, step) => ({ inputTokens: sum.inputTokens + step.inputTokens, outputTokens: sum.outputTokens + step.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  )
  const sessionsRoot = join(dshHome, 'sessions')
  const logFile = (await readdir(sessionsRoot, { recursive: true }))
    .find(entry => entry.includes(sessionId) && entry.endsWith('.jsonl'))

  console.log('\n── result ──')
  console.log(`answer : ${answer}`)
  console.log(`usage  : input=${total.inputTokens} output=${total.outputTokens}`)
  console.log(`session: ${logFile === undefined ? '(not found)' : join(sessionsRoot, logFile)}`)
} finally {
  await dispose()
  await ctx.fiber.dispose()
}
