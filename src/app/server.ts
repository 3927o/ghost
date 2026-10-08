import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { SessionManager } from './session-manager.ts'
import { messageRoutes } from './routes/message.ts'

export interface ServerConfig {
  host: string
  port: number
  sessionManager: SessionManager
}

export async function createServer(config: ServerConfig) {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  })

  // Register plugins
  await fastify.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })

  // Register routes
  await fastify.register(messageRoutes, { sessionManager: config.sessionManager })

  return fastify
}
