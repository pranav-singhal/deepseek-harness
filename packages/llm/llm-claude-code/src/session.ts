/**
 * One Claude Code process for a harness session.
 * Tool calls park the process until the next harness request supplies their results.
 * The process is the user's unmodified `claude`; this module never reads its credential files
 * and does not set `CLAUDE_AGENT_SDK_CLIENT_APP`, because the program owns its own HTTP.
 */

import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Query, SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import { claudeChildEnv } from './env.ts'
import {
  CLAUDE_CANCELLED,
  CLAUDE_EMPTY_PROMPT,
  CLAUDE_START_FAILED,
  SESSION_IDLE_MS,
  assistantFailure,
  claudeEffort,
  resultFailure,
  usageOf,
} from './messages.ts'
import { isRecord } from './record.ts'
import { appendText, pendingToolResults, renderTranscript, requestFingerprint } from './transcript.ts'
import { argumentsText, mcpToolNames, toolInputSchema } from './tools.ts'

interface PendingTool {
  readonly id: ToolCallId
  readonly name: string
  readonly arguments: string
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
}

type Pull =
  | { kind: 'message'; value: IteratorResult<SDKMessage> }
  | { kind: 'tool' }
  | { kind: 'failed'; error: unknown }

/**
 * A parked or running Claude Code query.
 * One instance serves every request for a single session and purpose.
 */
export class ClaudeChat {
  private queryHandle: Query | undefined
  private iterator: AsyncIterator<SDKMessage> | undefined
  private abort: AbortController | undefined
  private pending = new Map<string, PendingTool>()
  private announced = new Set<string>()
  private inflight: Promise<IteratorResult<SDKMessage>> | undefined
  private wake: (() => void) | undefined
  private failWait: ((error: LlmError) => void) | undefined
  private removeAbort: (() => void) | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private signal: AbortSignal | undefined
  private fingerprint = ''
  private live = false
  private stopped = false
  private parked = false

  /** Whether the live process is waiting for a tool result. */
  private isParked(): boolean {
    return this.parked
  }
  private sawOutput = false
  private blockIndex = 0

  /**
   * @param onAuthenticationFailure - drops the route when Claude Code reports a signed-out account.
   */
  constructor(private readonly onAuthenticationFailure: () => void) {}

  /**
   * Stream one harness request. A parked process continues when the request answers its tool calls.
   * @param options - the harness request. `signal` aborts the process.
   * @param executable - the user's `claude` program.
   * @returns harness stream chunks. A tool round ends with `tool-calls` and leaves the process running.
   */
  async *run(options: GenerateOptions, executable: string): AsyncGenerator<StreamChunk> {
    this.clearIdle()
    this.parked = false
    this.blockIndex = 0
    this.watch(options.signal)
    if (options.signal?.aborted) {
      this.release(cancelled())
      throw cancelled()
    }
    try {
      const next = this.live ? this.prepare(options) : 'restart'
      if (next === 'restart') {
        if (this.live) this.release(cancelled())
        this.open(options, executable)
      }
      yield* this.pump()
    } finally {
      if (this.signal?.aborted) this.release(cancelled())
      else if (this.isParked()) this.armIdle()
      else this.release(cancelled())
    }
  }

  /**
   * Stop the process and reject any tool call still waiting.
   * @param reason - the error delivered to a parked tool handler.
   */
  release(reason: LlmError): void {
    if (this.stopped) return
    this.stopped = true
    this.live = false
    this.parked = false
    this.clearIdle()
    this.removeAbort?.()
    this.removeAbort = undefined
    this.failWait?.(reason)
    this.failWait = undefined
    this.wake = undefined
    for (const call of this.pending.values()) call.reject(reason)
    this.pending.clear()
    this.announced.clear()
    const parked = this.inflight
    this.inflight = undefined
    if (parked !== undefined) void parked.then(() => undefined, () => undefined)
    const handle = this.queryHandle
    this.queryHandle = undefined
    this.iterator = undefined
    this.abort?.abort()
    this.abort = undefined
    if (handle === undefined) return
    try {
      handle.close()
    } catch (error: unknown) {
      // close() is best-effort after the process has already exited.
      void error
    }
  }

  private prepare(options: GenerateOptions): 'resume' | 'restart' {
    if (this.fingerprint !== requestFingerprint(options)) return 'restart'
    // A parked process is waiting on a tool call. An idle process was already released.
    /* v8 ignore next -- pending is empty only for a process that is no longer live. */
    if (this.pending.size === 0) return 'restart'
    const results = pendingToolResults(options.messages, new Set(this.pending.keys()))
    if (results === undefined) return 'restart'
    for (const [id, text] of results) this.pending.get(id)?.resolve(text)
    this.pending.clear()
    this.announced.clear()
    return 'resume'
  }

  private open(options: GenerateOptions, executable: string): void {
    const prompt = renderTranscript(options.messages)
    if (prompt.length === 0) throw new LlmError(CLAUDE_EMPTY_PROMPT, 'INVALID_REQUEST')
    const definitions = this.definitions(options.tools ?? [])
    const abort = new AbortController()
    const effort = claudeEffort(options.reasoningEffort)
    let handle: Query
    try {
      handle = query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: executable,
          cwd: process.cwd(),
          model: options.model,
          persistSession: false,
          settingSources: [],
          tools: [],
          strictMcpConfig: true,
          permissionMode: 'dontAsk',
          canUseTool: () => Promise.resolve({
            behavior: 'deny',
            message: 'DeepSeek Harness runs its own tools.',
          }),
          env: claudeChildEnv(),
          abortController: abort,
          stderr: () => {},
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: appendText(options),
            excludeDynamicSections: true,
          },
          ...(effort === undefined ? {} : { effort }),
          ...(definitions.length === 0 ? {} : {
            allowedTools: ['mcp__dsh__*'],
            mcpServers: {
              dsh: createSdkMcpServer({ name: 'dsh', version: '1.0.0', tools: definitions }),
            },
          }),
        },
      })
    } catch (error: unknown) {
      throw new LlmError(
        CLAUDE_START_FAILED,
        'SERVER',
        error instanceof Error ? { cause: error } : undefined,
      )
    }
    this.stopped = false
    this.abort = abort
    this.queryHandle = handle
    this.iterator = handle[Symbol.asyncIterator]()
    this.fingerprint = requestFingerprint(options)
    this.live = true
    this.sawOutput = false
  }

  private definitions(schemas: readonly ToolSchema[]) {
    const names = mcpToolNames(schemas.map(schema => schema.name))
    return schemas.map(schema => tool(
      names.get(schema.name) as string,
      schema.description,
      toolInputSchema(schema.parameters).shape,
      async (args) => {
        const id = brandString<ToolCallId>(randomUUID())
        const text = await new Promise<string>((resolve, reject) => {
          this.pending.set(id, {
            id,
            name: schema.name,
            arguments: argumentsText(args),
            resolve,
            reject,
          })
          this.wake?.()
        })
        return { content: [{ type: 'text' as const, text }] }
      },
      { alwaysLoad: true },
    ))
  }

  private async *pump(): AsyncGenerator<StreamChunk> {
    for (;;) {
      if (this.signal?.aborted) throw cancelled()
      const event = await this.pull()
      if (event.kind === 'tool') {
        await Promise.resolve()
        const calls = this.unannounced()
        // A wake is installed only when a tool call is registered.
        /* v8 ignore next -- the registered call is still unannounced when the wake resolves. */
        if (calls.length === 0) continue
        yield* this.emitTools(calls)
        this.parked = true
        return
      }
      if (event.kind === 'failed') throw this.failure(event.error)
      if (event.value.done === true) {
        if (!this.sawOutput) throw new LlmError('Claude Code returned an empty response.', EMPTY_RESPONSE_CODE)
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (yield* this.consume(event.value.value)) return
    }
  }

  private *consume(message: SDKMessage): Generator<StreamChunk, boolean> {
    if (message.type === 'assistant') return yield* this.consumeAssistant(message)
    if (message.type === 'result') return yield* this.consumeResult(message)
    return false
  }

  private *consumeAssistant(message: SDKAssistantMessage): Generator<StreamChunk, boolean> {
    if (typeof message.parent_tool_use_id === 'string') return false
    if (message.aborted === true) throw cancelled()
    if (message.error !== undefined) {
      const failure = assistantFailure(message.error)
      if (failure.code === 'AUTH') this.onAuthenticationFailure()
      throw failure
    }
    for (const block of assistantBlocks(message)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        yield* this.emitText(block.text, 'text')
      } else if (block.type === 'thinking' || block.type === 'reasoning') {
        const text = typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string' ? block.text : ''
        yield* this.emitText(text, 'reasoning')
      }
    }
    return false
  }

  private *consumeResult(message: SDKResultMessage): Generator<StreamChunk, boolean> {
    if (message.subtype !== 'success' || message.is_error) {
      const errors = 'errors' in message && Array.isArray(message.errors)
        ? message.errors.filter((item): item is string => typeof item === 'string')
        : []
      throw resultFailure(errors)
    }
    if (!this.sawOutput) {
      if (message.result.length > 0) yield* this.emitText(message.result, 'text')
      else throw new LlmError('Claude Code returned an empty response.', EMPTY_RESPONSE_CODE)
    }
    yield { type: 'usage', usage: usageOf(message.usage) }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return true
  }

  private *emitText(text: string, kind: 'text' | 'reasoning'): Generator<StreamChunk> {
    if (text.length === 0) return
    this.sawOutput = true
    const index = this.blockIndex
    this.blockIndex += 1
    if (kind === 'reasoning') {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'reasoning', text } }
      return
    }
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
  }

  private *emitTools(calls: readonly PendingTool[]): Generator<StreamChunk> {
    for (const call of calls) {
      const index = this.blockIndex
      this.blockIndex += 1
      const block = { type: 'tool-call' as const, id: call.id, name: call.name, arguments: call.arguments }
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block }
      this.announced.add(call.id)
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  private unannounced(): PendingTool[] {
    return [...this.pending.values()].filter(call => !this.announced.has(call.id))
  }

  private pull(): Promise<Pull> {
    const iterator = this.iterator
    /* v8 ignore start -- open() installs the iterator before the first pull, and release() stops the pump. */
    if (iterator === undefined) return Promise.resolve({ kind: 'failed', error: new LlmError(CLAUDE_START_FAILED, 'SERVER') })
    /* v8 ignore stop */
    // The tool handler can run inside iterator.next() before this function continues,
    // so the wake callback has to be installed first.
    const toolWait = new Promise<void>((resolve) => { this.wake = resolve })
    const abortWait = new Promise<LlmError>((resolve) => { this.failWait = resolve })
    const inflight = this.inflight ?? iterator.next()
    this.inflight = inflight
    return new Promise((resolve) => {
      let settled = false
      const finish = (event: Pull): void => {
        if (settled) return
        settled = true
        resolve(event)
      }
      inflight.then(
        (value) => {
          if (settled) return
          this.inflight = undefined
          finish({ kind: 'message', value })
        },
        (error: unknown) => {
          if (settled) return
          this.inflight = undefined
          finish({ kind: 'failed', error })
        },
      )
      void toolWait.then(() => { finish({ kind: 'tool' }) })
      void abortWait.then((error) => { finish({ kind: 'failed', error }) })
    })
  }

  private failure(error: unknown): LlmError {
    if (this.signal?.aborted) return cancelled()
    if (error instanceof LlmError) return error
    return new LlmError(CLAUDE_START_FAILED, 'SERVER', error instanceof Error ? { cause: error } : undefined)
  }

  private watch(signal: AbortSignal | undefined): void {
    this.removeAbort?.()
    this.removeAbort = undefined
    this.signal = signal
    if (signal === undefined) return
    const onAbort = (): void => {
      this.failWait?.(cancelled())
      if (this.parked) this.release(cancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.removeAbort = () => { signal.removeEventListener('abort', onAbort) }
  }

  private armIdle(): void {
    /* v8 ignore next -- release() is the only writer of stopped, and it does not arm a timer afterward. */
    if (this.stopped) return
    this.clearIdle()
    const timer = setTimeout(() => { this.release(cancelled()) }, SESSION_IDLE_MS)
    timer.unref()
    this.idle = timer
  }

  private clearIdle(): void {
    if (this.idle === undefined) return
    clearTimeout(this.idle)
    this.idle = undefined
  }
}

function cancelled(): LlmError {
  return new LlmError(CLAUDE_CANCELLED, 'ABORTED')
}

function assistantBlocks(message: SDKAssistantMessage): readonly Record<string, unknown>[] {
  const content: unknown = message.message.content
  if (!Array.isArray(content)) return []
  return content.filter(isRecord)
}
