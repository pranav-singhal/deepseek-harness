/**
 * LLM adapter that delegates model calls to the user's Claude Code program.
 * Attribution headers are not attached: the unmodified `claude` process owns HTTP,
 * and an extra client marker can make a subscription login reject the request.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ClaudeCodeController } from './controller.ts'
import { CLAUDE_CODE_DISPLAY_NAME, CLAUDE_CODE_PROVIDER } from './messages.ts'

/** Adapter registered on the `claude-code` route while Claude Code is signed in. */
export class ClaudeCodeAdapter extends LlmAdapter {
  /**
   * @param controller - the plugin state that probes Claude Code and owns the live processes.
   */
  constructor(private readonly controller: ClaudeCodeController) {
    super()
  }

  /**
   * Describe the Claude Code route.
   * @param provider - the route id. Only `claude-code` is owned here.
   * @returns the Models page label.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider)
    return { id: provider, name: CLAUDE_CODE_DISPLAY_NAME }
  }

  /**
   * List models from the latest signed-in probe.
   * @param provider - the route id.
   * @returns text-only models in Claude Code's order.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    return Promise.resolve(this.controller.modelInfos())
  }

  /**
   * Resolve one model id, including effort levels Claude Code reported for it.
   * An id the probe did not list still resolves so a caller can name it directly.
   * @param provider - the route id.
   * @param model - the model id.
   * @returns display metadata and text-only input.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider)
    return Promise.resolve(this.controller.resolve(model))
  }

  /**
   * Stream one request through the user's Claude Code process.
   * @param options - the harness request.
   * @returns the chunk stream. The call fails with `AUTH` when Claude Code is unavailable.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.controller.stream(options)
  }

  private assertProvider(provider: string): void {
    if (provider !== CLAUDE_CODE_PROVIDER) {
      throw new LlmError(`llm-claude-code does not own provider "${provider}"`, 'INVALID_ADAPTER')
    }
  }
}
