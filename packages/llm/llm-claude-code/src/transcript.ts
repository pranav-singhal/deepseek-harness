/** Render a harness request as text for one Claude Code process. */

import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { CLAUDE_CODE_HARNESS_NOTE } from './messages.ts'

/**
 * System text for the Claude Code preset append.
 * The fixed harness note comes first. Matching system text is included once.
 * @param options - the harness request.
 * @returns the append text.
 */
export function appendText(options: GenerateOptions): string {
  const system = systemText(options)
  return system.length > 0 ? `${CLAUDE_CODE_HARNESS_NOTE}\n\n${system}` : CLAUDE_CODE_HARNESS_NOTE
}

/**
 * System text from the one-shot field and system-role messages.
 * @param options - the harness request.
 * @returns the combined system text, without the fixed note.
 */
export function systemText(options: GenerateOptions): string {
  const parts: string[] = []
  if (options.system !== undefined && options.system.length > 0) parts.push(options.system)
  for (const message of options.messages) {
    if (message.role !== 'system') continue
    const text = blockTexts(message.content).join('\n')
    if (text.length > 0 && !parts.includes(text)) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * Render every non-system message as labeled text.
 * Image and file bytes are replaced with omission lines. An empty result is an empty string.
 * @param messages - the harness request messages.
 * @returns the user prompt, or `''` when there is nothing to send.
 */
export function renderTranscript(messages: readonly RequestMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const rendered = renderMessage(message)
    if (rendered !== undefined) lines.push(rendered)
  }
  return lines.join('\n\n')
}

/**
 * Text for each parked tool call, when the request answers every one of them.
 * @param messages - the next harness request.
 * @param ids - tool-call ids the Claude Code process is waiting on.
 * @returns one result string per id, or undefined when any id is unanswered.
 */
export function pendingToolResults(
  messages: readonly RequestMessage[],
  ids: ReadonlySet<string>,
): Map<string, string> | undefined {
  const found = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'tool' || !ids.has(message.toolCallId)) continue
    found.set(message.toolCallId, toolResultText(message))
  }
  if (found.size !== ids.size) return undefined
  return found
}

/**
 * Stable identity of the request fields that a parked Claude Code process already received.
 * A change means the parked process cannot continue and the transcript is sent again.
 * @param options - the harness request.
 * @returns a JSON fingerprint.
 */
export function requestFingerprint(options: GenerateOptions): string {
  return JSON.stringify({
    model: options.model,
    system: systemText(options),
    effort: options.reasoningEffort ?? '',
    tools: (options.tools ?? []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  })
}

function renderMessage(message: RequestMessage): string | undefined {
  switch (message.role) {
    case 'system':
      return undefined
    case 'user':
      return labeled('User', blockTexts(message.content).join('\n'))
    case 'assistant':
      return labeled('Model', blockTexts(message.content).join('\n'))
    case 'developer':
      return labeled('Developer', blockTexts(message.content).join('\n'))
    case 'tool': {
      const body = blockTexts(message.content).join('\n')
      const text = message.isError === true
        ? `Tool failed:\n${body}`
        : (body.length > 0 ? body : '(no output)')
      return `Tool result (${message.toolCallId})\n${text}`
    }
    /* v8 ignore start -- request roles are closed; assertNever keeps the switch exhaustive. */
    default:
      return assertNever(message)
    /* v8 ignore stop */
  }
}

function toolResultText(message: Extract<RequestMessage, { role: 'tool' }>): string {
  const body = blockTexts(message.content).join('\n')
  return message.isError === true ? `Tool failed:\n${body}` : (body.length > 0 ? body : '(no output)')
}

function labeled(label: string, body: string): string {
  return body.length > 0 ? `${label}\n${body}` : label
}

function blockTexts(blocks: readonly ContentBlock[]): string[] {
  return blocks.map(blockText).filter(text => text.length > 0)
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return block.text.length > 0 ? `Reasoning:\n${block.text}` : ''
    case 'image':
      return '[Image omitted. This route sends text only.]'
    case 'file':
      return `[File ${block.attachment.name} omitted. This route sends text only.]`
    case 'tool-call':
      return `Tool call ${block.name} ${block.arguments}`
    case 'tool-addition':
      return `Tool added: ${block.toolName}`
    case 'tool-removal':
      return `Tool removed: ${block.toolName}`
    /* v8 ignore start -- ContentBlockMap is merge-extensible; known blocks return above. */
    default:
      return ''
    /* v8 ignore stop */
  }
}
