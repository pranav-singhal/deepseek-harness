/** Claude Code account and model reports. Email and tokens are never retained. */

import type { ClaudeEffort } from './messages.ts'
import { claudeEffort } from './messages.ts'
import { isRecord } from './record.ts'

/** The login fields needed to decide whether Claude Code can serve a request. */
export interface ClaudeAccountReport {
  /** Claude Code's token source. `none` means no subscription login was reported. */
  readonly tokenSource?: string
  /** Claude Code's API-key source. `none` means no API key was reported. */
  readonly apiKeySource?: string
}

/** One model Claude Code offered during initialization. */
export interface ClaudeModelReport {
  /** Model id passed to Claude Code. */
  readonly value: string
  /** Selector label. */
  readonly displayName: string
  /** Optional capability description. */
  readonly description: string
  /** Effort values Claude Code reported for this model. */
  readonly supportedEffortLevels: readonly ClaudeEffort[]
}

/**
 * Whether Claude Code reported a usable login.
 * A missing account, or both sources `none` or absent, is signed out.
 * `apiKeySource: none` alone does not mean signed out when a token source is present.
 * @param account - the initialization account, without email or secrets.
 * @returns whether a later model call can use the existing Claude Code login.
 */
export function isClaudeLoggedIn(account: ClaudeAccountReport | undefined): boolean {
  if (account === undefined) return false
  const token = account.tokenSource
  const key = account.apiKeySource
  return (token !== undefined && token !== 'none') || (key !== undefined && key !== 'none')
}

/**
 * Read the account and model list from an initialization result.
 * The sentinel model id `default` is skipped. Email and credential fields are not copied.
 * @param value - the SDK initialization result.
 * @returns the login report and the usable models.
 */
export function readProbe(value: unknown): { account: ClaudeAccountReport | undefined; models: ClaudeModelReport[] } {
  if (!isRecord(value)) return { account: undefined, models: [] }
  return { account: readAccount(value.account), models: readModels(value.models) }
}

function readAccount(value: unknown): ClaudeAccountReport | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.tokenSource === 'string' ? { tokenSource: value.tokenSource } : {}),
    ...(typeof value.apiKeySource === 'string' ? { apiKeySource: value.apiKeySource } : {}),
  }
}

function readModels(value: unknown): ClaudeModelReport[] {
  if (!Array.isArray(value)) return []
  const models: ClaudeModelReport[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item) || typeof item.value !== 'string') continue
    if (item.value.length === 0 || item.value === 'default' || seen.has(item.value)) continue
    seen.add(item.value)
    models.push({
      value: item.value,
      displayName: typeof item.displayName === 'string' && item.displayName.length > 0 ? item.displayName : item.value,
      description: typeof item.description === 'string' ? item.description : '',
      supportedEffortLevels: effortsOf(item.supportedEffortLevels),
    })
  }
  return models
}

function effortsOf(value: unknown): ClaudeEffort[] {
  if (!Array.isArray(value)) return []
  const levels: ClaudeEffort[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const level = claudeEffort(item)
    if (level !== undefined && !levels.includes(level)) levels.push(level)
  }
  return levels
}
