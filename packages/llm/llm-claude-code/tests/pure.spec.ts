import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  createMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { isClaudeLoggedIn, readProbe } from '../src/account.ts'
import { claudeChildEnv } from '../src/env.ts'
import { findClaudeExecutable } from '../src/executable.ts'
import {
  CLAUDE_CODE_HARNESS_NOTE,
  assistantFailure,
  claudeEffort,
  claudeEffortName,
  resultFailure,
  usageOf,
} from '../src/messages.ts'
import { settingsNamespace } from '../src/index.ts'
import {
  appendText,
  pendingToolResults,
  renderTranscript,
  requestFingerprint,
  systemText,
} from '../src/transcript.ts'
import { argumentsText, mcpToolNames, toolInputSchema } from '../src/tools.ts'

const callId = brandString<ToolCallId>('call-1')

describe('Claude Code executable lookup', () => {
  it('uses an executable DSH_CLAUDE_PATH and does not fall back to PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-lookup-'))
    const override = join(dir, 'claude')
    const onPath = join(dir, 'bin', 'claude')
    writeFileSync(override, '#!/bin/sh\n')
    chmodSync(override, 0o755)
    expect(findClaudeExecutable({ DSH_CLAUDE_PATH: override, PATH: join(dir, 'bin') })).toEqual({
      kind: 'found',
      path: override,
    })
    expect(findClaudeExecutable({ DSH_CLAUDE_PATH: join(dir, 'missing'), PATH: onPath })).toEqual({
      kind: 'override-invalid',
    })
  })

  it('searches PATH, including an empty segment and Windows names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-path-'))
    const executable = join(dir, 'claude')
    writeFileSync(executable, '#!/bin/sh\n')
    chmodSync(executable, 0o755)
    expect(findClaudeExecutable({ PATH: `:${dir}` }, 'linux')).toEqual({ kind: 'found', path: executable })
    expect(findClaudeExecutable({ PATH: join(dir, 'empty') }, 'linux')).toEqual({ kind: 'missing' })
    expect(findClaudeExecutable({}, 'linux')).toEqual({ kind: 'missing' })

    const windows = mkdtempSync(join(tmpdir(), 'claude-win-'))
    const command = join(windows, 'claude.cmd')
    writeFileSync(command, '@echo off\n')
    chmodSync(command, 0o755)
    expect(findClaudeExecutable({ PATH: `;${windows};` }, 'win32')).toEqual({ kind: 'found', path: command })
  })
})

describe('Claude Code child environment', () => {
  it('copies the parent environment, strips credentials, and applies isolation', () => {
    const env = claudeChildEnv({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'key',
      ANTHROPIC_AUTH_TOKEN: 'auth',
      ANTHROPIC_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      MCP_TOOL_TIMEOUT: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh',
      EMPTY: undefined,
    })
    expect(env.HOME).toBe('/Users/me')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_SIMPLE).toBeUndefined()
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
    expect(env.MCP_TOOL_TIMEOUT).toBeUndefined()
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.DISABLE_AUTO_COMPACT).toBe('1')
    expect(env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY).toBe('0')
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
    expect(env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe('1')
  })
})

describe('Claude Code account report', () => {
  it('treats a subscription login as signed in and ignores email', () => {
    expect(isClaudeLoggedIn({ tokenSource: 'claude.ai', apiKeySource: 'none' })).toBe(true)
    expect(isClaudeLoggedIn({ apiKeySource: 'ANTHROPIC_API_KEY' })).toBe(true)
    expect(isClaudeLoggedIn({ tokenSource: 'none', apiKeySource: 'none' })).toBe(false)
    expect(isClaudeLoggedIn({ tokenSource: 'none' })).toBe(false)
    expect(isClaudeLoggedIn(undefined)).toBe(false)
    expect(readProbe({
      account: { email: 'person@example.com', tokenSource: 'claude.ai', apiKeySource: 'none' },
      models: [
        { value: 'default', displayName: 'Default' },
        { value: '', displayName: 'empty' },
        { value: 'sonnet', displayName: 'Sonnet', description: 'fast', supportedEffortLevels: ['low', 'nope', 'low', 1] },
        { value: 'sonnet', displayName: 'duplicate' },
        { displayName: 'missing id' },
        'nope',
        { value: 'opus' },
      ],
    })).toEqual({
      account: { tokenSource: 'claude.ai', apiKeySource: 'none' },
      models: [
        { value: 'sonnet', displayName: 'Sonnet', description: 'fast', supportedEffortLevels: ['low'] },
        { value: 'opus', displayName: 'opus', description: '', supportedEffortLevels: [] },
      ],
    })
    expect(readProbe(null)).toEqual({ account: undefined, models: [] })
    expect(readProbe({ account: 'nope', models: 'nope' })).toEqual({ account: undefined, models: [] })
    expect(readProbe({ account: { tokenSource: 1, apiKeySource: 2 } }).account).toEqual({})
  })
})

describe('Claude Code failure mapping', () => {
  it('maps model errors and usage', () => {
    expect(assistantFailure('authentication_failed').code).toBe('AUTH')
    expect(assistantFailure('oauth_org_not_allowed').code).toBe('AUTH')
    expect(assistantFailure('account_on_hold').code).toBe('AUTH')
    expect(assistantFailure('billing_error').code).toBe('QUOTA')
    expect(assistantFailure('rate_limit').code).toBe('RATE_LIMIT')
    expect(assistantFailure('invalid_request').code).toBe('INVALID_REQUEST')
    expect(assistantFailure('model_not_found').message).toContain('model_not_found')
    expect(assistantFailure('overloaded').code).toBe('SERVER')
    expect(assistantFailure('max_output_tokens').code).toBe('SERVER')
    expect(resultFailure([]).message).toBe('Claude Code failed the request.')
    expect(resultFailure(['  ', 'short']).message).toBe('short')
    expect(resultFailure(['x'.repeat(600)]).message).toHaveLength(500)
    expect(usageOf(null)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(usageOf({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: Number.NaN }))
      .toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
    expect(usageOf({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 })).toEqual({
      inputTokens: 2, outputTokens: 3, totalTokens: 14, cacheReadTokens: 4, cacheWriteTokens: 5,
    })
    expect(claudeEffort(undefined)).toBeUndefined()
    expect(claudeEffort('high')).toBe('high')
    expect(claudeEffort('ultra')).toBeUndefined()
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const
    expect(levels.map(level => claudeEffortName(level))).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
  })
})

describe('Claude Code transcript', () => {
  it('renders text, omissions, and tool results', () => {
    const image: ContentBlock = {
      type: 'image',
      attachment: {
        attachmentId: brandString<AttachmentId>(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }
    const file: ContentBlock = {
      type: 'file',
      attachment: {
        attachmentId: brandString<AttachmentId>(`sha256:${'b'.repeat(64)}`),
        name: 'notes.txt',
        bytes: 4,
      },
    }
    const messages = [
      createSystemMessage('be brief'),
      createSystemMessage('be brief'),
      createUserMessage({ content: [{ type: 'text', text: 'hi' }, image, file], source: { kind: 'user' } }),
      createUserMessage({ content: [], source: { kind: 'user' } }),
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'reasoning', text: '' },
          { type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' },
          { type: 'text', text: 'answer' },
        ],
        source: { kind: 'model', provider: 'claude-code', model: 'sonnet' },
      }),
      createDeveloperMessage({
        content: [{ type: 'tool-addition', toolName: 'lookup' }, { type: 'tool-removal', toolName: 'lookup' }],
        source: { kind: 'user' },
      }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'found' }], isError: false }),
      createToolResultMessage({ callId: brandString<ToolCallId>('call-2'), content: [{ type: 'text', text: 'bad' }], isError: true }),
      createToolResultMessage({ callId: brandString<ToolCallId>('call-3'), content: [], isError: false }),
    ]
    const rendered = renderTranscript(messages)
    expect(rendered).toContain('User\nhi')
    expect(rendered).toContain('[Image omitted. This route sends text only.]')
    expect(rendered).toContain('[File notes.txt omitted. This route sends text only.]')
    expect(rendered).toContain('Reasoning:\nthink')
    expect(rendered).toContain('Tool call lookup {}')
    expect(rendered).toContain('Tool added: lookup')
    expect(rendered).toContain('Tool removed: lookup')
    expect(rendered).toContain(`Tool result (${callId})\nfound`)
    expect(rendered).toContain('Tool failed:')
    expect(rendered).not.toContain('be brief')
    expect(systemText({ provider: 'claude-code', model: 'sonnet', messages, system: 'be brief' })).toBe('be brief')
    expect(appendText({ provider: 'claude-code', model: 'sonnet', messages: [] })).toBe(CLAUDE_CODE_HARNESS_NOTE)
    expect(appendText({ provider: 'claude-code', model: 'sonnet', messages, system: 'extra' })).toContain('extra')
    expect(pendingToolResults(messages, new Set([brandString<ToolCallId>('call-2')]))?.get('call-2')).toBe('Tool failed:\nbad')
    expect(pendingToolResults(messages, new Set([callId]))?.get(callId)).toBe('found')
    expect(pendingToolResults(messages, new Set([callId, 'missing']))).toBeUndefined()
    expect(pendingToolResults([
      createToolResultMessage({ callId, content: [], isError: false }),
    ], new Set([callId]))?.get(callId)).toBe('(no output)')
    const fingerprint = requestFingerprint({ provider: 'claude-code', model: 'sonnet', messages, tools: [] })
    expect(requestFingerprint({ provider: 'claude-code', model: 'opus', messages, tools: [] })).not.toBe(fingerprint)
  })
})

describe('Claude Code tool schemas', () => {
  it('sanitizes names and converts JSON schema fields', () => {
    expect([...mcpToolNames(['a.b', 'a_b', '', 'tool']).values()]).toEqual(['a_b', 'a_b_2', 'tool', 'tool_2'])
    const schema = toolInputSchema({
      type: 'object',
      required: ['q'],
      properties: {
        q: { type: 'string' },
        n: { type: 'integer' },
        f: { type: 'number' },
        ok: { type: 'boolean' },
        tags: { type: 'array' },
        meta: { type: 'object' },
        extra: { type: 'other' },
        skip: 'nope',
      },
    })
    expect(schema.parse({ q: 'hi', n: 1, also: true })).toMatchObject({ q: 'hi', n: 1, also: true })
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ q: 'hi' }).success).toBe(true)
    expect(toolInputSchema({}).safeParse({}).success).toBe(true)
    expect(argumentsText({ q: 'hi' })).toBe('{"q":"hi"}')
    expect(argumentsText('nope')).toBe('{}')
  })
})

describe('settings namespace', () => {
  it('uses the entry id when one is set', () => {
    expect(settingsNamespace(undefined)).toBe('llm-claude-code')
    expect(settingsNamespace('')).toBe('llm-claude-code')
    expect(settingsNamespace('custom')).toBe('custom')
  })
})

describe('credential files', () => {
  it('never reads Claude Code files', () => {
    const directory = new URL('../src/', import.meta.url)
    for (const name of readdirSync(directory)) {
      expect(readFileSync(new URL(name, directory), 'utf8')).not.toMatch(/\breadFile(Sync)?\b/)
    }
  })
})

describe('package README', () => {
  it('quotes the appended note', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const translated = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8')
    expect(readme).toContain(CLAUDE_CODE_HARNESS_NOTE)
    expect(translated).toContain(CLAUDE_CODE_HARNESS_NOTE)
    expect(readme).toContain('```markdown')
  })
})
