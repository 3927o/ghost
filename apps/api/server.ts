/** HTTP application. Its dependency graph contains only business contracts and storage. */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { ChatService } from './chat-service.ts'
import { messageRoutes } from './routes/message.ts'

export async function createServer({ chat, logger = true }: { chat: ChatService; logger?: boolean }) {
  const server = Fastify({
    logger: logger ? { level: 'info', transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z' } } } : false,
  })
  await server.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })
  await server.register(messageRoutes, { chat })
  return server
}
