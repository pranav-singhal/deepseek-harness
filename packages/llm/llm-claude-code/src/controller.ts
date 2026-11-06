/**
 * Probe and registration owner for the Claude Code route.
 * The route stays in the Models directory even when Claude Code is missing,
 * and it is registered for requests only after a signed-in probe reports models.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  GenerateOptions,
  LlmConfigurableProvider,
  LlmModelInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { isClaudeLoggedIn, type ClaudeModelReport } from './account.ts'
import { ClaudeCodeAdapter } from './adapter.ts'
import { findClaudeExecutable } from './executable.ts'
import {
  CLAUDE_CANCELLED,
  CLAUDE_CHECKING,
  CLAUDE_CODE_DISPLAY_NAME,
  CLAUDE_CODE_PROVIDER,
  CLAUDE_DISABLED,
  CLAUDE_NOT_INSTALLED,
  CLAUDE_NOT_SIGNED_IN,
  CLAUDE_NO_MODELS,
  CLAUDE_PATH_INVALID,
  CLAUDE_PROBE_FAILED,
  PROBE_INTERVAL_MS,
  claudeEffortName,
} from './messages.ts'
import { probeClaude } from './probe.ts'
import { ClaudeChat } from './session.ts'

/** Plugin configuration this controller reads on each probe. */
export interface ClaudeCodeConfig {
  /**
   * When false, Claude Code is not started.
   * A loaded plugin passes a volatile reference. Tests may pass a plain boolean.
   */
  readonly enabled?: boolean | Volatile<boolean>
}

/**
 * Read the current enabled flag.
 * An omitted flag stays on, matching the schema default.
 * @param config - the live plugin configuration.
 * @returns whether the route may start Claude Code.
 */
export function routeEnabled(config: ClaudeCodeConfig): boolean {
  const enabled = config.enabled
  if (isVolatile(enabled)) return enabled.get()
  return enabled !== false
}

/** Owns the Models row, the route registration, and one process per session. */
export class ClaudeCodeController {
  /** Adapter instance registered while the route is ready. */
  readonly adapter = new ClaudeCodeAdapter(this)
  private error: string | undefined
  private models: ClaudeModelReport[] = []
  private executable: string | undefined
  private ready = false
  private disposed = false
  private published = ''
  private probeFlight: Promise<void> | undefined
  private probeClose: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private directory: DirectoryRegistrationHandle | undefined
  private registration: AdapterRegistrationHandle | undefined
  private chats = new Map<string, ClaudeChat>()
  private tails = new Map<string, Promise<void>>()

  /**
   * @param ctx - the plugin context. Directory and route updates are published here.
   * @param config - live plugin configuration. `enabled` is read on every probe.
   * @param settingsNs - settings namespace shown on the Models row.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ClaudeCodeConfig,
    private readonly settingsNs: string,
  ) {
    this.error = routeEnabled(config) ? CLAUDE_CHECKING : CLAUDE_DISABLED
  }

  /** Publish the initial row and start probing when the route is enabled. */
  start(): void {
    this.publish()
    void this.refresh()
  }

  /**
   * Probe again. Overlapping calls share one in-flight probe.
   * @returns a promise that settles when that probe has published its result.
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (!routeEnabled(this.config)) {
      this.stopTimer()
      this.ready = false
      this.executable = undefined
      this.models = []
      this.error = CLAUDE_DISABLED
      this.closeChats()
      this.publish()
      return Promise.resolve()
    }
    this.ensureTimer()
    this.probeFlight ??= this.runProbe().finally(() => { this.probeFlight = undefined })
    return this.probeFlight
  }

  /**
   * Models from the latest signed-in probe.
   * @returns text-only catalog entries.
   */
  modelInfos(): LlmModelInfo[] {
    return this.models.map(model => ({
      provider: CLAUDE_CODE_PROVIDER,
      id: model.value,
      name: model.displayName,
      ...(model.description.length > 0 ? { description: model.description } : {}),
      inputModalities: ['text' as const],
    }))
  }

  /**
   * Resolve one model id against the latest probe.
   * @param model - the requested model id.
   * @returns display metadata. Effort levels are included when Claude Code reported them.
   */
  resolve(model: string): LlmResolvedModelInfo {
    const known = this.models.find(item => item.value === model)
    const efforts = known?.supportedEffortLevels ?? []
    return {
      provider: CLAUDE_CODE_PROVIDER,
      id: model,
      name: known?.displayName ?? model,
      ...(known !== undefined && known.description.length > 0 ? { description: known.description } : {}),
      inputModalities: ['text'],
      ...(efforts.length > 0 ? {
        reasoning: {
          efforts: efforts.map(level => ({
            id: brandString<ReasoningEffortId>(level),
            name: claudeEffortName(level),
          })),
        },
      } : {}),
    }
  }

  /**
   * Stream one request once Claude Code is signed in.
   * A route that is not ready is probed once more, then fails with `AUTH`.
   * @param options - the harness request.
   * @returns the chunk stream.
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.executable === undefined || !this.ready) await this.refresh()
    if (this.disposed || this.executable === undefined || !this.ready) {
      throw new LlmError(this.error ?? CLAUDE_PROBE_FAILED, 'AUTH')
    }
    const executable = this.executable
    const session = options.sessionId ?? 'anonymous'
    // Purpose keys are merge-extended strings. A conversation call leaves the field absent.
    const purpose = (options as GenerateOptions<string>).purpose ?? 'chat'
    const key = `${session}\u0000${purpose}`
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      yield* this.chat(key).run(options, executable)
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** Drop the route after Claude Code reports that its login is gone. */
  onAuthenticationFailure(): void {
    this.ready = false
    this.models = []
    this.error = CLAUDE_NOT_SIGNED_IN
    this.closeChats()
    this.publish()
  }

  /** Stop probes and processes. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopTimer()
    this.probeClose?.()
    this.probeClose = undefined
    this.closeChats()
    this.registration?.()
    this.registration = undefined
    this.directory?.()
    this.directory = undefined
  }

  private async runProbe(): Promise<void> {
    const found = findClaudeExecutable(process.env)
    if (found.kind !== 'found') {
      this.failProbe(found.kind === 'override-invalid' ? CLAUDE_PATH_INVALID : CLAUDE_NOT_INSTALLED)
      return
    }
    try {
      const report = await probeClaude(found.path, (handle) => {
        this.probeClose = () => { handle.close() }
      })
      if (this.disposed || !routeEnabled(this.config)) return
      this.executable = found.path
      if (!isClaudeLoggedIn(report.account)) {
        this.failProbe(CLAUDE_NOT_SIGNED_IN)
        return
      }
      if (report.models.length === 0) {
        this.failProbe(CLAUDE_NO_MODELS)
        return
      }
      this.models = [...report.models]
      this.ready = true
      this.error = undefined
      this.publish()
    } catch (error: unknown) {
      if (this.disposed) return
      this.failProbe(CLAUDE_PROBE_FAILED)
      void error
    } finally {
      this.probeClose = undefined
    }
  }

  private failProbe(message: string): void {
    this.ready = false
    this.models = []
    this.executable = undefined
    this.error = message
    this.publish()
  }

  private publish(): void {
    if (this.disposed) return
    const entry = this.entry()
    const signature = JSON.stringify({
      error: entry.error ?? '',
      ready: this.ready,
      models: this.models.map(model => model.value),
    })
    if (signature === this.published && this.directory !== undefined) return
    this.published = signature
    if (this.directory === undefined) this.directory = this.ctx.llm.registerConfigurableProviders([entry])
    else this.directory.replace([entry])
    const routes = this.ready ? [CLAUDE_CODE_PROVIDER] : []
    if (this.registration === undefined) {
      if (routes.length === 0) return
      this.registration = this.ctx.llm.registerAdapter(routes, this.adapter)
    } else {
      this.registration.replace(routes)
    }
    if (this.ready) this.ctx.emit('llm/models-updated', CLAUDE_CODE_PROVIDER)
  }

  private entry(): LlmConfigurableProvider {
    return {
      provider: CLAUDE_CODE_PROVIDER,
      displayName: CLAUDE_CODE_DISPLAY_NAME,
      settingsNs: this.settingsNs,
      settingsPath: ['enabled'],
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  private chat(key: string): ClaudeChat {
    const existing = this.chats.get(key)
    if (existing !== undefined) return existing
    const created = new ClaudeChat(() => { this.onAuthenticationFailure() })
    this.chats.set(key, created)
    return created
  }

  private closeChats(): void {
    for (const chat of this.chats.values()) chat.release(new LlmError(CLAUDE_CANCELLED, 'ABORTED'))
    this.chats.clear()
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.disposed) return
    this.timer = setInterval(() => {
      if (this.ready) return
      void this.refresh()
    }, PROBE_INTERVAL_MS)
    this.timer.unref()
  }

  private stopTimer(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
