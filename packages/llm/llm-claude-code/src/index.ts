/**
 * Claude models through the user's locally installed Claude Code program.
 * Model calls run in that unmodified program under the user's own Claude Code login.
 * This plugin does not collect, store, refresh, or forward Claude credentials,
 * and it does not read Claude Code's credential files.
 *
 * ```yaml
 * - id: llm-claude-code
 *   name: '@deepseek-ai/dsh-llm-claude-code'
 * ```
 *
 * Set `DSH_CLAUDE_PATH` when `claude` is not on `PATH`. Set `enabled: false` to keep the route off.
 *
 * @module @deepseek-ai/dsh-llm-claude-code
 */

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ClaudeCodeController, type ClaudeCodeConfig } from './controller.ts'

export const name = 'llm-claude-code'
export const inject = ['llm']

/** Deployment configuration. `enabled` defaults to true and can change without a restart. */
export interface Config {
  /** When false, Claude Code is not started and the Models row explains how to turn the route on. */
  enabled: Volatile<boolean>
}

/** Schema for {@link Config}. `enabled` is volatile so the Models page can see the default. */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
})

/**
 * Settings namespace for the Models row.
 * A profile entry id wins. A direct load uses the plugin name.
 * @param entryId - the loader entry id, when this plugin is mounted as an entry.
 * @returns the namespace the directory row points at.
 */
export function settingsNamespace(entryId: string | undefined): string {
  return entryId !== undefined && entryId.length > 0 ? entryId : name
}

/**
 * Register the Claude Code route and keep its Models row current.
 * The row uses `settingsPath: ['enabled']` so the page does not open an API-key card.
 * @param ctx - the plugin context. Requires `llm`. Uses `settings` when that service is present.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ClaudeCodeConfig): void {
  const controller = new ClaudeCodeController(ctx, config, settingsNamespace(ctx.fiber.entry?.options.id))
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('loader/volatile-update', () => { void controller.refresh() })
  ctx.effect(() => {
    controller.start()
    return () => { controller.dispose() }
  })
}

export { CLAUDE_CODE_DISPLAY_NAME, CLAUDE_CODE_HARNESS_NOTE, CLAUDE_CODE_PROVIDER } from './messages.ts'
