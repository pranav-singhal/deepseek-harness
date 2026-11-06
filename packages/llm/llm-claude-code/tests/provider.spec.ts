import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVolatile } from '@deepseek-ai/cosmokit'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, {
  EMPTY_RESPONSE_CODE,
  LlmError,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ReasoningEffortId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ClaudeCodeController } from '../src/controller.ts'
import { probeClaude } from '../src/probe.ts'
import * as plugin from '../src/index.ts'
import {
  CLAUDE_CHECKING,
  CLAUDE_DISABLED,
  CLAUDE_NOT_INSTALLED,
  CLAUDE_NOT_SIGNED_IN,
  CLAUDE_NO_MODELS,
  CLAUDE_PATH_INVALID,
  CLAUDE_PROBE_FAILED,
  CLAUDE_START_FAILED,
  PROBE_INTERVAL_MS,
  SESSION_IDLE_MS,
} from '../src/messages.ts'

interface HandlerResult { content: { type: 'text'; text: string }[] }
type Handler = (args: Record<string, unknown>) => Promise<HandlerResult>

const sdk = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  calls: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
  probe: (): object => { throw new Error('probe was not installed') },
  chats: [] as Array<() => object>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    sdk.calls.push(input)
    if (input.prompt !== null && typeof input.prompt === 'object' && Symbol.asyncIterator in input.prompt) {
      void (input.prompt as AsyncIterable<never>)[Symbol.asyncIterator]().next()
      return sdk.probe()
    }
    const next = sdk.chats.shift()
    if (next === undefined) throw new Error('unexpected Claude Code chat')
    return next()
  },
  createSdkMcpServer: (options: { name: string; version?: string; tools?: unknown[] }) => ({
    name: options.name,
    version: options.version,
    tools: options.tools,
  }),
  tool: (name: string, description: string, schema: unknown, handler: Handler, extras?: unknown) => {
    sdk.handlers.set(name, handler)
    return { name, description, schema, extras }
  },
}))

class SettingsDouble extends Service {
  readonly configured: unknown[] = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  configure(options: unknown, fiber: unknown): () => void {
    this.configured.push([options, fiber])
    return () => {}
  }
}

const READY = {
  account: { tokenSource: 'claude.ai', apiKeySource: 'none', email: 'person@example.com' },
  models: [
    { value: 'default', displayName: 'Default' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'fast', supportedEffortLevels: ['low', 'high', 'nope'] },
    { value: 'opus', displayName: 'Opus', description: '' },
  ],
}

function probeHandle(report: unknown, options?: { hang?: boolean; fail?: Error; closeError?: boolean }) {
  return {
    initializationResult: () => {
      if (options?.hang === true) return new Promise(() => {})
      if (options?.fail !== undefined) return Promise.reject(options.fail)
      return Promise.resolve(report)
    },
    close: () => {
      if (options?.closeError === true) throw new Error('close failed')
    },
    async *[Symbol.asyncIterator]() { /* the probe prompt stays idle */ },
  }
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, ...extra }
}

function success(result: string, usage: object = {
  input_tokens: 3,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 1,
}) {
  return { type: 'result', subtype: 'success', is_error: false, result, usage }
}

function scripted(messages: unknown[], options?: { closeError?: boolean; reject?: unknown }) {
  return {
    close: vi.fn(() => {
      if (options?.closeError === true) throw new Error('close failed')
    }),
    async *[Symbol.asyncIterator]() {
      if (options?.reject !== undefined) throw options.reject
      for (const message of messages) yield message
    },
  }
}

function toolChat() {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      const pending = [...sdk.handlers.values()].map(handler => handler({ q: 'x' }))
      const results = await Promise.all(pending)
      yield assistant([{ type: 'text', text: results.map(result => result.content[0]?.text ?? '').join('|') }])
      yield success('done', { input_tokens: 1, output_tokens: 1 })
    },
  }
}

async function executable(name = 'claude'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-bin-'))
  const bin = join(dir, name)
  await writeFile(bin, '#!/bin/sh\nexit 0\n')
  await chmod(bin, 0o755)
  onTestFinished(() => { /* the temp directory is disposable test state */ })
  return bin
}

async function useExecutable(): Promise<string> {
  const bin = await executable()
  vi.stubEnv('PATH', join(bin, '..'))
  vi.stubEnv('DSH_CLAUDE_PATH', '')
  vi.stubEnv('HOME', '/Users/me')
  vi.stubEnv('ANTHROPIC_API_KEY', 'secret')
  vi.stubEnv('CLAUDE_AGENT_SDK_CLIENT_APP', 'dsh')
  return bin
}

function request(
  text = 'hi',
  extra: Partial<Omit<GenerateOptions, 'purpose'>> & { purpose?: string } = {},
): GenerateOptions {
  return {
    provider: 'claude-code',
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
    sessionId: brandString<Branded<'SessionId'>>('session'),
    ...extra,
  } as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function directory(ctx: Context) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = ctx.llm.listConfigurableProviders().find(item => item.provider === 'claude-code')
    if (row !== undefined && row.error !== CLAUDE_CHECKING) return row
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }
  throw new Error('Claude Code probe did not settle')
}

async function boot(config: { enabled?: boolean | Volatile<boolean> } = { enabled: true }) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  const controller = new ClaudeCodeController(ctx, config, 'llm-claude-code')
  controller.start()
  return { ctx, controller }
}

beforeEach(() => {
  sdk.handlers.clear()
  sdk.calls.length = 0
  sdk.chats.length = 0
  sdk.probe = () => probeHandle(READY)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Claude Code route', () => {
  it('registers models after a signed-in probe and streams text', async () => {
    const bin = await useExecutable()
    sdk.chats.push(() => scripted([
      { type: 'system', subtype: 'init' },
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'thinking' },
        { type: 'reasoning', text: 'because' },
        { type: 'reasoning' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'text', text: 'hello' },
      ]),
      { type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'hidden' }] } },
      success('hello'),
    ]))
    const { ctx, controller } = await boot()
    const row = await directory(ctx)
    expect(row.error).toBeUndefined()
    expect(row.settingsPath).toEqual(['enabled'])
    expect(ctx.llm.listProviders().map(item => item.name)).toContain('Claude (via Claude Code)')
    expect(await ctx.llm.listModels('claude-code')).toEqual([
      { provider: 'claude-code', id: 'sonnet', name: 'Sonnet', description: 'fast', inputModalities: ['text'] },
      { provider: 'claude-code', id: 'opus', name: 'Opus', inputModalities: ['text'] },
    ])
    expect(await ctx.llm.resolveModelInfo('claude-code', 'sonnet')).toMatchObject({
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
    expect(await ctx.llm.resolveModelInfo('claude-code', 'custom')).toMatchObject({ id: 'custom', name: 'custom' })
    expect(() => { void controller.adapter.listModels('other') }).toThrow(LlmError)
    expect(() => { void controller.adapter.resolveModel('other', 'custom') }).toThrow(LlmError)
    expect(() => { controller.adapter.providerInfo('other') }).toThrow(LlmError)
    const firstSignal = new AbortController()
    const secondSignal = new AbortController()
    await probeClaude(bin)
    const probeCall = sdk.calls.find(call => typeof call.prompt !== 'string')
    ;(probeCall?.options.stderr as (line: string) => void)('ignored')
    const chunks = await collect(ctx.llm.stream(request('hi', {
      signal: firstSignal.signal,
      system: 'be brief',
      reasoningEffort: brandString<ReasoningEffortId>('high'),
      messages: [
        createSystemMessage('be brief'),
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
      ],
    })))
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'hmm')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello')).toBe(true)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 11 },
    })
    const chat = sdk.calls.find(call => typeof call.prompt === 'string')
    expect(chat?.options.pathToClaudeCodeExecutable).toBe(bin)
    expect(chat?.options.effort).toBe('high')
    expect(String(chat?.prompt)).toContain('User\nhi')
    expect(String(chat?.prompt)).not.toContain('be brief')
    const append = (chat?.options.systemPrompt as { append?: string }).append
    expect(append).toContain('be brief')
    expect((chat?.options.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined()
    expect((chat?.options.env as Record<string, string>).CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined()
    expect((chat?.options.env as Record<string, string>).CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')
    const denied = await (chat?.options.canUseTool as (name: string, input: object, options: object) => Promise<{ behavior: string }>)(
      'Bash', {}, { signal: new AbortController().signal, toolUseID: '1' },
    )
    expect(denied).toMatchObject({ behavior: 'deny' })
    ;(chat?.options.stderr as (line: string) => void)('ignored')
    sdk.chats.push(
      () => scripted([success('only result', { input_tokens: 1, output_tokens: 1 })]),
      () => scripted([], { reject: 'boom' }),
      () => scripted([assistant([], { aborted: true })]),
    )
    const second = await collect(controller.stream(request('next', { signal: secondSignal.signal })))
    expect(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'only result')).toBe(true)
    expect(second.find(chunk => chunk.type === 'block-start')).toMatchObject({ index: 0 })
    await expect(collect(controller.stream({
      provider: 'claude-code',
      model: 'sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'anon' }], source: { kind: 'user' } })],
    }))).rejects.toMatchObject({ code: 'SERVER', message: CLAUDE_START_FAILED })
    await expect(collect(controller.stream(request('stop', { signal: new AbortController().signal })))).rejects.toMatchObject({
      code: 'ABORTED',
    })
    controller.dispose()
    await expect(collect(controller.stream(request('gone', { purpose: 'gone' })))).rejects.toThrow(CLAUDE_PROBE_FAILED)
    controller.onAuthenticationFailure()
  })

  it('parks a tool call and resumes it when the harness returns the result', async () => {
    await useExecutable()
    sdk.chats.push(toolChat)
    const { ctx, controller } = await boot()
    await directory(ctx)
    const tool = { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }
    const first = await collect(controller.stream(request('hi', { tools: [tool] })))
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    if (call === undefined || call.type !== 'block-end' || call.block.type !== 'tool-call') throw new Error('missing tool call')
    expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    const second = await collect(controller.stream(request('hi', {
      tools: [tool],
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
        createToolResultMessage({ callId: call.block.id, content: [{ type: 'text', text: 'found' }], isError: false }),
      ],
    })))
    expect(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'found')).toBe(true)
    expect(sdk.calls.filter(item => typeof item.prompt === 'string')).toHaveLength(1)
    const options = sdk.calls.find(item => typeof item.prompt === 'string')?.options
    expect(options?.allowedTools).toEqual(['mcp__dsh__*'])
    expect(options?.mcpServers).toBeDefined()
  })

  it('restarts a parked process when its tool result is missing', async () => {
    await useExecutable()
    sdk.chats.push(toolChat, () => scripted([assistant([{ type: 'text', text: 'again' }]), success('again')]))
    const { ctx, controller } = await boot()
    await directory(ctx)
    const tool = { name: 'lookup', description: 'Look up', parameters: {} }
    await collect(controller.stream(request('hi', { tools: [tool] })))
    const second = await collect(controller.stream(request('hi', { tools: [tool] })))
    expect(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'again')).toBe(true)
  })

  it('starts a new process when the parked request no longer matches', async () => {
    await useExecutable()
    sdk.chats.push(toolChat, () => scripted([assistant([{ type: 'text', text: 'restarted' }]), success('restarted')]))
    const { ctx, controller } = await boot()
    await directory(ctx)
    const tool = { name: 'lookup', description: 'Look up', parameters: {} }
    const first = await collect(controller.stream(request('hi', { tools: [tool] })))
    const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    if (call === undefined || call.type !== 'block-end' || call.block.type !== 'tool-call') throw new Error('missing tool call')
    const second = await collect(controller.stream(request('hi', {
      model: 'opus',
      tools: [tool],
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
        createToolResultMessage({ callId: call.block.id, content: [{ type: 'text', text: 'found' }], isError: false }),
      ],
    })))
    expect(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'restarted')).toBe(true)
    const prompts = sdk.calls.filter(item => typeof item.prompt === 'string').map(item => String(item.prompt))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('found')
  })

  it('reports installation and login failures without reading credential files', async () => {
    vi.stubEnv('PATH', await mkdtemp(join(tmpdir(), 'empty-path-')))
    vi.stubEnv('DSH_CLAUDE_PATH', '')
    const missing = await boot()
    expect((await directory(missing.ctx)).error).toBe(CLAUDE_NOT_INSTALLED)
    await expect(collect(missing.controller.stream(request()))).rejects.toThrow(CLAUDE_NOT_INSTALLED)
    missing.controller.dispose()
    missing.controller.dispose()

    const bin = await executable()
    vi.stubEnv('DSH_CLAUDE_PATH', join(bin, 'missing'))
    const invalid = await boot()
    expect((await directory(invalid.ctx)).error).toBe(CLAUDE_PATH_INVALID)

    vi.stubEnv('DSH_CLAUDE_PATH', '')
    vi.stubEnv('PATH', join(bin, '..'))
    sdk.probe = () => probeHandle({ account: { tokenSource: 'none', apiKeySource: 'none' }, models: READY.models })
    const signedOut = await boot()
    expect((await directory(signedOut.ctx)).error).toBe(CLAUDE_NOT_SIGNED_IN)

    sdk.probe = () => probeHandle({ account: { tokenSource: 'claude.ai' }, models: [{ value: 'default' }] })
    const noModels = await boot()
    expect((await directory(noModels.ctx)).error).toBe(CLAUDE_NO_MODELS)

    sdk.probe = () => probeHandle(READY, { fail: new Error('boom') })
    const failed = await boot()
    expect((await directory(failed.ctx)).error).toBe(CLAUDE_PROBE_FAILED)

    sdk.probe = () => probeHandle(READY, { closeError: true })
    const closed = await boot()
    expect((await directory(closed.ctx)).error).toBeUndefined()
  })

  it('turns the route off without starting Claude Code', async () => {
    await useExecutable()
    const plain = await boot({ enabled: false })
    expect((await directory(plain.ctx)).error).toBe(CLAUDE_DISABLED)
    const wrapped = await boot({ enabled: createVolatile(false) })
    expect((await directory(wrapped.ctx)).error).toBe(CLAUDE_DISABLED)
    expect(sdk.calls).toHaveLength(0)
    const on = await boot({ enabled: createVolatile(true) })
    expect((await directory(on.ctx)).error).toBeUndefined()
  })

  it('drops the route when Claude Code reports an authentication failure', async () => {
    await useExecutable()
    sdk.chats.push(() => scripted([assistant([], { error: 'authentication_failed' })]))
    const { ctx, controller } = await boot()
    await directory(ctx)
    await expect(collect(controller.stream(request()))).rejects.toMatchObject({ code: 'AUTH' })
    expect(ctx.llm.listProviders().map(item => item.id)).not.toContain('claude-code')
    expect(ctx.llm.listConfigurableProviders()[0]?.error).toBe(CLAUDE_NOT_SIGNED_IN)
  })

  it.each([
    ['billing_error', 'QUOTA'],
    ['rate_limit', 'RATE_LIMIT'],
    ['invalid_request', 'INVALID_REQUEST'],
    ['max_output_tokens', 'SERVER'],
  ] as const)('maps a %s model failure to %s', async (error, code) => {
    await useExecutable()
    sdk.chats.push(() => scripted([assistant([], { error })]))
    const { ctx, controller } = await boot()
    await directory(ctx)
    await expect(collect(controller.stream(request()))).rejects.toMatchObject({ code })
  })

  it('maps a failed result and an empty result', async () => {
    await useExecutable()
    sdk.chats.push(
      () => scripted([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['nope', 1] }]),
      () => scripted([{ type: 'result', subtype: 'success', is_error: true }]),
      () => scripted([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: 'nope' }]),
      () => scripted([success('')]),
      () => scripted([]),
      () => scripted([assistant([{ type: 'text', text: 'kept' }])]),
      () => scripted([{ type: 'assistant', message: { content: 'plain' } }, success('from result', { input_tokens: 1, output_tokens: 1 })]),
      () => { throw new Error('spawn failed') },
      () => { throw 'spawn' },
      () => scripted([], { reject: new Error('disk') }),
    )
    const { ctx, controller } = await boot()
    await directory(ctx)
    await expect(collect(controller.stream(request()))).rejects.toMatchObject({ code: 'SERVER', message: 'nope' })
    await expect(collect(controller.stream(request('missing-errors')))).rejects.toMatchObject({ message: 'Claude Code failed the request.' })
    await expect(collect(controller.stream(request('bad-errors')))).rejects.toMatchObject({ message: 'Claude Code failed the request.' })
    await expect(collect(controller.stream(request('again')))).rejects.toMatchObject({ code: EMPTY_RESPONSE_CODE })
    await expect(collect(controller.stream(request('empty-turn')))).rejects.toMatchObject({ code: EMPTY_RESPONSE_CODE })
    const done = await collect(controller.stream(request('third', { purpose: 'title' })))
    expect(done.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(done.find(chunk => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } })
    const plain = await collect(controller.stream(request('plain', { purpose: 'summary' })))
    expect(plain.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from result')).toBe(true)
    await expect(collect(controller.stream(request('fourth', { purpose: 'title' })))).rejects.toMatchObject({
      code: 'SERVER',
      message: CLAUDE_START_FAILED,
    })
    await expect(collect(controller.stream(request('fifth', { purpose: 'title' })))).rejects.toMatchObject({
      code: 'SERVER',
      message: CLAUDE_START_FAILED,
    })
    await expect(collect(controller.stream(request('disk', { purpose: 'disk' })))).rejects.toMatchObject({
      code: 'SERVER',
      message: CLAUDE_START_FAILED,
    })
    await expect(collect(controller.stream({ ...request(), messages: [createSystemMessage('only')] }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('aborts before the process starts, while it is running, and while a tool call is being emitted', async () => {
    await useExecutable()
    const hung = Promise.withResolvers<boolean>()
    sdk.chats.push(
      () => scripted([], { reject: new LlmError('nope', 'SERVER') }),
      () => ({
        close: vi.fn(),
        async *[Symbol.asyncIterator]() { await hung.promise },
      }),
      toolChat,
    )
    const { ctx, controller } = await boot()
    await directory(ctx)
    await expect(collect(controller.stream(request()))).rejects.toMatchObject({ code: 'SERVER', message: 'nope' })

    const early = new AbortController()
    early.abort()
    await expect(collect(controller.stream(request('early', { signal: early.signal, purpose: 'fresh' })))).rejects.toMatchObject({ code: 'ABORTED' })

    let started = false
    const running = new AbortController()
    sdk.chats[0] = () => ({
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        started = true
        await hung.promise
      },
    })
    const pending = collect(controller.stream(request('run', { signal: running.signal, purpose: 'chat' })))
    await vi.waitFor(() => { expect(started).toBe(true) })
    running.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    hung.resolve(true)

    const tool = { name: 'lookup', description: 'Look up', parameters: {} }
    const chunks = await collect(controller.stream(request('tool', { tools: [tool], purpose: 'other' })))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    const stopping = new AbortController()
    sdk.chats.push(() => scripted([
      assistant([{ type: 'text', text: 'partial' }]),
      success('partial'),
    ]))
    await expect((async () => {
      for await (const chunk of controller.stream(request('partial', { signal: stopping.signal, purpose: 'partial' }))) {
        if (chunk.type === 'text-delta') stopping.abort()
      }
    })()).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('closes a parked process after it sits idle, and again when the caller aborts', async () => {
    vi.useFakeTimers()
    await useExecutable()
    const parked = toolChat()
    const aborted = toolChat()
    sdk.chats.push(() => parked, () => aborted)
    const { controller } = await boot()
    const tool = { name: 'lookup', description: 'Look up', parameters: {} }
    await collect(controller.stream(request('park', { tools: [tool] })))
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS)
    expect(parked.close).toHaveBeenCalled()

    const stopping = new AbortController()
    const stream = controller.stream(request('abort', { tools: [tool], purpose: 'other', signal: stopping.signal }))
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    stopping.abort()
    expect(aborted.close).toHaveBeenCalled()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('probes again while Claude Code is missing and stops after it is ready', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PATH', await mkdtemp(join(tmpdir(), 'later-path-')))
    vi.stubEnv('DSH_CLAUDE_PATH', '')
    const { controller } = await boot()
    expect(sdk.calls).toHaveLength(0)
    const bin = await executable()
    vi.stubEnv('PATH', join(bin, '..'))
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(sdk.calls.length).toBeGreaterThan(0)
    const before = sdk.calls.length
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
    expect(sdk.calls).toHaveLength(before)
    controller.dispose()
  })

  it('times out a probe that never reports', async () => {
    vi.useFakeTimers()
    await useExecutable()
    sdk.probe = () => probeHandle(READY, { hang: true })
    const { ctx } = await boot()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ctx.llm.listConfigurableProviders()[0]?.error).toBe(CLAUDE_PROBE_FAILED)
  })

  it('queues two streams for one session and separates a different purpose', async () => {
    await useExecutable()
    const gate = Promise.withResolvers<boolean>()
    const order: string[] = []
    sdk.chats.push(
      () => ({
        close: vi.fn(),
        async *[Symbol.asyncIterator]() {
          order.push('first')
          await gate.promise
          yield assistant([{ type: 'text', text: 'one' }])
          yield success('one', { input_tokens: 1, output_tokens: 1 })
        },
      }),
      () => scripted([assistant([{ type: 'text', text: 'two' }]), success('two', { input_tokens: 1, output_tokens: 1 })]),
    )
    const { ctx, controller } = await boot()
    await directory(ctx)
    const first = collect(controller.stream(request('one')))
    const second = collect(controller.stream(request('two', { purpose: 'chat' })))
    await vi.waitFor(() => { expect(order).toEqual(['first']) })
    expect(sdk.calls.filter(call => typeof call.prompt === 'string')).toHaveLength(1)
    gate.resolve(true)
    expect((await first).some(chunk => chunk.type === 'text-delta' && chunk.text === 'one')).toBe(true)
    expect((await second).some(chunk => chunk.type === 'text-delta' && chunk.text === 'two')).toBe(true)
  })

  it('omits images and files from the prompt', async () => {
    await useExecutable()
    sdk.chats.push(() => scripted([assistant([{ type: 'text', text: 'text only' }]), success('text only')], { closeError: true }))
    const { ctx, controller } = await boot()
    await directory(ctx)
    const imageId = brandString<AttachmentId>(`sha256:${'c'.repeat(64)}`)
    const fileId = brandString<AttachmentId>(`sha256:${'d'.repeat(64)}`)
    await collect(controller.stream(request('picture', {
      reasoningEffort: brandString<ReasoningEffortId>('ultra'),
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'picture' },
          { type: 'image', attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
          { type: 'file', attachment: { attachmentId: fileId, name: 'notes.txt', bytes: 4 } },
        ],
        source: { kind: 'user' },
      })],
    })))
    const prompt = String(sdk.calls.find(call => typeof call.prompt === 'string')?.prompt)
    expect(prompt).toContain('[Image omitted. This route sends text only.]')
    expect(prompt).toContain('[File notes.txt omitted. This route sends text only.]')
    expect(sdk.calls.find(call => typeof call.prompt === 'string')?.options.effort).toBeUndefined()
  })

  it('disposes an in-flight probe', async () => {
    await useExecutable()
    let closed = false
    let rejectProbe = (_error: Error): void => {}
    sdk.probe = () => ({
      initializationResult: () => new Promise((_resolve, reject) => { rejectProbe = reject }),
      close: () => {
        closed = true
        rejectProbe(new Error('closed'))
      },
      async *[Symbol.asyncIterator]() { /* idle */ },
    })
    const { controller } = await boot()
    await vi.waitFor(() => { expect(sdk.calls.length).toBeGreaterThan(0) })
    controller.dispose()
    expect(closed).toBe(true)
    await expect(collect(controller.stream(request()))).rejects.toThrow(CLAUDE_CHECKING)
  })
})

describe('Claude Code plugin', () => {
  it('configures settings, follows volatile updates, and uses the entry id', async () => {
    const bin = await useExecutable()
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    const settings = new SettingsDouble(ctx)
    const config = { enabled: true }
    const fiber = await ctx.plugin({
      name: plugin.name,
      inject: plugin.inject,
      apply(child: Context, childConfig: typeof config) {
        child.fiber.entry = { options: { id: 'custom-ns', name: plugin.name } } as Entry
        plugin.apply(child, childConfig)
      },
    }, config)
    const row = await directory(ctx)
    expect(row.settingsNs).toBe('custom-ns')
    expect(row.error).toBeUndefined()
    expect(settings.configured).toEqual([[{ auto: false }, fiber.ctx.fiber]])
    const calls = sdk.calls.length
    fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(() => { expect(sdk.calls.length).toBeGreaterThan(calls) })
    config.enabled = false
    fiber.ctx.emit('loader/volatile-update', [])
    expect(ctx.llm.listConfigurableProviders()[0]?.error).toBe(CLAUDE_DISABLED)
    expect(sdk.calls.at(-1)?.options.pathToClaudeCodeExecutable).toBe(bin)
    await fiber.dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('loads through the plugin export when no entry id is set', async () => {
    await useExecutable()
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LlmRuntime)
    new SettingsDouble(ctx)
    await ctx.plugin(plugin, { enabled: true })
    expect((await directory(ctx)).settingsNs).toBe('llm-claude-code')
  })
})
