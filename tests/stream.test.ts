/** SSE replay uses whole business snapshots and handles split UTF-8 records. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMessageStream } from '../apps/web/src/lib/message-stream.ts'
import type { RunSnapshot, RunStreamEvent } from '@ghost/contracts'

test('snapshot stream handles fragmented UTF-8, skipped revisions and terminal failure', async () => {
  const base: RunSnapshot = {
    id: 'run', conversationId: 'main', assistantMessageId: 'assistant-run', status: 'running', text: '你好',
    error: null, revision: 3, createdAt: 1, updatedAt: 2,
    parts: [], lastEventSeq: 0,
  }
  const records = [base, { ...base, status: 'failed' as const, error: '中断', revision: 7 }]
  const bytes = new TextEncoder().encode(records.map(run => `id: ${run.revision}\r\ndata: ${JSON.stringify({ type: 'snapshot', run })}\r\n\r\n`).join(''))
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const observed: RunStreamEvent[] = []
  await readMessageStream(body, event => observed.push(event))
  assert.deepEqual(observed, records.map(run => ({ type: 'snapshot', run })))
})

test('premature observation close is reconnectable rather than a terminal run result', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  await assert.rejects(readMessageStream(body, () => {}), /disconnected/)
})
