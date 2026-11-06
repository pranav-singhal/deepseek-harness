/**
 * Ask the user's Claude Code whether it is installed and signed in.
 * The probe never sends a user message and never reads credential files.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { readProbe } from './account.ts'
import type { ClaudeAccountReport, ClaudeModelReport } from './account.ts'
import { claudeChildEnv } from './env.ts'
import { CLAUDE_CODE_HARNESS_NOTE, PROBE_TIMEOUT_MS } from './messages.ts'

/** Account and models from one Claude Code initialization. */
export interface ClaudeProbeReport {
  /** Login sources, without email or tokens. */
  readonly account: ClaudeAccountReport | undefined
  /** Usable models. The sentinel id `default` is already removed. */
  readonly models: readonly ClaudeModelReport[]
}

/**
 * Start Claude Code, read its initialization report, and close it.
 * The prompt iterator stays idle so the process does not make a model call.
 * @param executable - absolute or PATH-resolved path to the user's `claude`.
 * @param onStart - receives the live query so the caller can close it on shutdown.
 * @returns the account and model reports.
 * @throws Error when initialization does not finish within {@link PROBE_TIMEOUT_MS}.
 */
export async function probeClaude(
  executable: string,
  onStart?: (handle: Query) => void,
): Promise<ClaudeProbeReport> {
  let finish!: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  const abort = new AbortController()
  let rejectTimeout!: (error: Error) => void
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
  const timer = setTimeout(() => {
    abort.abort()
    rejectTimeout(new Error('timeout'))
  }, PROBE_TIMEOUT_MS)
  timer.unref()
  const handle = query({ prompt: idlePrompt(done), options: probeOptions(executable, abort) })
  onStart?.(handle)
  try {
    return readProbe(await Promise.race([handle.initializationResult(), timeout]))
  } finally {
    clearTimeout(timer)
    finish()
    try {
      handle.close()
    } catch (error: unknown) {
      // close() is best-effort after a failed or timed-out start.
      void error
    }
  }
}

async function* idlePrompt(done: Promise<void>): AsyncGenerator<never, void> {
  await done
}

function probeOptions(executable: string, abort: AbortController): Options {
  return {
    pathToClaudeCodeExecutable: executable,
    cwd: process.cwd(),
    persistSession: false,
    settingSources: [],
    tools: [],
    strictMcpConfig: true,
    permissionMode: 'dontAsk',
    env: claudeChildEnv(),
    abortController: abort,
    stderr: () => {},
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: CLAUDE_CODE_HARNESS_NOTE,
      excludeDynamicSections: true,
    },
  }
}
