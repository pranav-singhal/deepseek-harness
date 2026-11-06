/** User-facing status text and failure mapping for the Claude Code route. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { isRecord } from './record.ts'

/** Provider route id registered on `ctx.llm`. */
export const CLAUDE_CODE_PROVIDER = 'claude-code'
/** Models page label. */
export const CLAUDE_CODE_DISPLAY_NAME = 'Claude (via Claude Code)'
/** User-settings namespace. The resolved `enabled` field keeps the row configured. */
export const CLAUDE_CODE_SETTINGS_NS = 'llm-claude-code'
/**
 * Fixed note appended to the Claude Code preset prompt.
 * The package README quotes this string.
 */
export const CLAUDE_CODE_HARNESS_NOTE = 'You are answering inside DeepSeek Harness. Use only the dsh tools. Do not use Claude Code built-in tools. Do not ask for an API key.'

/** Shown before the first probe finishes. */
export const CLAUDE_CHECKING = 'Checking Claude Code. If you have not signed in, run claude and type /login.'
/** Shown when no executable `claude` is on `PATH`. */
export const CLAUDE_NOT_INSTALLED = 'Claude Code is not installed. Install Claude Code, then run claude and type /login.'
/** Shown when `DSH_CLAUDE_PATH` is set and is not executable. */
export const CLAUDE_PATH_INVALID = 'DSH_CLAUDE_PATH is not an executable Claude Code program. Install Claude Code, then run claude and type /login.'
/** Shown when Claude Code starts but reports no login. */
export const CLAUDE_NOT_SIGNED_IN = 'Claude Code is installed but not signed in. Run claude, then type /login.'
/** Shown when the probe process fails or times out. */
export const CLAUDE_PROBE_FAILED = 'Claude Code could not be checked. Install Claude Code, then run claude and type /login.'
/** Shown when a signed-in probe reports no usable models. */
export const CLAUDE_NO_MODELS = 'Claude Code did not report any models. Run claude, then type /login.'
/** Shown when `llm-claude-code.enabled` is false. */
export const CLAUDE_DISABLED = 'Claude (via Claude Code) is turned off. Set llm-claude-code.enabled to true to use it.'
/** Shown when a model call cannot start the local program. */
export const CLAUDE_START_FAILED = 'Claude Code could not start. Install Claude Code, then run claude and type /login.'
/** Shown when the caller aborts the request. */
export const CLAUDE_CANCELLED = 'The request was cancelled.'
/** Shown when a request has no model-visible user text. */
export const CLAUDE_EMPTY_PROMPT = 'Claude Code received an empty prompt.'

/** How often a missing or signed-out installation is probed again. */
export const PROBE_INTERVAL_MS = 30_000
/** How long one installation probe may wait for Claude Code to report its account. */
export const PROBE_TIMEOUT_MS = 30_000
/** How long a parked Claude Code process waits for the next harness tool result. */
export const SESSION_IDLE_MS = 10 * 60 * 1000

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Effort values the Claude Agent SDK accepts. */
export type ClaudeEffort = typeof EFFORT_LEVELS[number]

const EFFORT_NAMES: Record<ClaudeEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/**
 * Narrow a harness effort id to a Claude Code effort.
 * @param value - the requested effort, when the caller set one.
 * @returns the SDK effort, or undefined when the value is absent or unsupported.
 */
export function claudeEffort(value: string | undefined): ClaudeEffort | undefined {
  return EFFORT_LEVELS.find(level => level === value)
}

/**
 * Selector label for one Claude Code effort.
 * @param level - an SDK effort value.
 * @returns the Models picker label.
 */
export function claudeEffortName(level: ClaudeEffort): string {
  return EFFORT_NAMES[level]
}

/**
 * Map a Claude Code usage object onto harness token counts.
 * Cache fields are omitted when the report does not include them.
 * @param value - the SDK result usage, or anything else.
 * @returns disjoint input, output, and cache counts.
 */
export function usageOf(value: unknown): TokenUsage {
  const record = isRecord(value) ? value : {}
  const inputTokens = finite(record.input_tokens)
  const outputTokens = finite(record.output_tokens)
  const cacheRead = finite(record.cache_read_input_tokens)
  const cacheWrite = finite(record.cache_creation_input_tokens)
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheRead + cacheWrite,
  }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  return usage
}

/**
 * Map one Claude Code model-message error onto a harness failure.
 * Authentication failures use the sign-in instruction; the text never includes credential material.
 * @param error - the SDK error tag.
 * @returns the failure the stream throws.
 */
export function assistantFailure(error: string): LlmError {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
      return new LlmError(CLAUDE_NOT_SIGNED_IN, 'AUTH')
    case 'billing_error':
      return new LlmError('Claude Code rejected the request because the account quota is exhausted.', 'QUOTA')
    case 'rate_limit':
      return new LlmError('Claude Code rate-limited the request.', 'RATE_LIMIT')
    case 'invalid_request':
    case 'model_not_found':
      return new LlmError(`Claude Code rejected the request (${error}).`, 'INVALID_REQUEST')
    default:
      return new LlmError(`Claude Code failed the request (${error}).`, 'SERVER')
  }
}

/**
 * Map a failed Claude Code result onto a harness failure.
 * The detail is Claude Code's own error text, capped so a huge report cannot flood the UI.
 * @param errors - result error strings.
 * @returns a server failure.
 */
export function resultFailure(errors: readonly string[]): LlmError {
  const detail = errors.map(item => item.trim()).filter(item => item.length > 0).join('; ').slice(0, 500)
  return new LlmError(detail.length > 0 ? detail : 'Claude Code failed the request.', 'SERVER')
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
