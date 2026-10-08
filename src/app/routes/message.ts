import type { FastifyInstance } from 'fastify'
import type { SessionManager } from '../session-manager.ts'
import type { ConversationContext, MessageRequest, MessageResponse, MessageStreamEvent } from '../../shared/types.ts'
import { resolveConversation } from '../conversation-routing.ts'

const identityProperties = {
  userId: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' },
  channel: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9_-]*$' },
}

const messageSchema = {
  body: {
    type: 'object',
    required: ['userId', 'channel', 'content'],
    additionalProperties: false,
    properties: {
      ...identityProperties,
      content: { type: 'string', minLength: 1, maxLength: 100000, pattern: '\\S' },
    },
  },
}

export async function messageRoutes(
  fastify: FastifyInstance,
  { sessionManager }: { sessionManager: SessionManager }
) {
  fastify.get<{ Querystring: ConversationContext }>('/api/conversation', {
    schema: {
      querystring: {
        type: 'object',
        required: ['userId', 'channel'],
        additionalProperties: false,
        properties: identityProperties,
      },
    },
  }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.query)
    reply.header('Cache-Control', 'no-store')
    try {
      return await sessionManager.getConversation(userId, conversationId)
    } catch (error) {
      fastify.log.error(error, 'Failed to load conversation')
      return reply.code(500).send({ error: 'Failed to load conversation' })
    }
  })

  // POST /api/message - Send a message and get response
  fastify.post<{ Body: MessageRequest }>('/api/message', { schema: messageSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.body)
    const { content } = request.body

    try {
      const result = await sessionManager.runTurn({
        userId,
        conversationId,
        message: content,
      })

      const response: MessageResponse = {
        conversationId,
        sessionId: result.sessionId,
      }

      return reply.send(response)
    } catch (error) {
      fastify.log.error(error, 'Failed to process message')
      return reply.code(500).send({ error: 'Failed to process message' })
    }
  })

  // POST /api/message/stream - Send a message and stream events via SSE
  fastify.post<{ Body: MessageRequest }>('/api/message/stream', { schema: messageSchema }, async (request, reply) => {
    const { userId, conversationId } = resolveConversation(request.body)
    const { content } = request.body

    // Take ownership of the stream and preserve headers set by Fastify plugins.
    reply.hijack()
    reply.raw.writeHead(200, {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const send = (data: MessageStreamEvent) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }
    }

    // Send initial metadata
    send({
      type: 'metadata',
      conversationId,
    })

    try {
      await sessionManager.runTurn({
        userId,
        conversationId,
        message: content,
        onText: (text) => send({ type: 'text', text }),
        onEvent: (event) => {
          // Stream each event to client
          send({
            type: 'event',
            event,
          })
        },
      })

      // Send completion signal
      send({ type: 'done' })
    } catch (error) {
      fastify.log.error(error, 'Failed to process message')
      send({
        type: 'error',
        error: 'Failed to process message',
      })
    } finally {
      reply.raw.end()
    }
  })

  // GET /api/health - Health check
  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      activeSessions: sessionManager.getActiveSessionCount(),
    }
  })
}
