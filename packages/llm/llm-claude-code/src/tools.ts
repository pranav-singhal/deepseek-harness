/** Harness tool schemas as Claude Agent SDK tool inputs. */

import { z } from 'zod'
import { isRecord } from './record.ts'

/**
 * Map harness tool names to MCP tool names.
 * Characters outside the MCP name set become underscores. Collisions gain a numeric suffix.
 * @param names - harness tool names in request order.
 * @returns harness name to MCP name.
 */
export function mcpToolNames(names: readonly string[]): Map<string, string> {
  const used = new Set<string>()
  const namesByTool = new Map<string, string>()
  for (const name of names) {
    const base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
    let candidate = base
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `${base}_${String(suffix)}`
      suffix += 1
    }
    used.add(candidate)
    namesByTool.set(name, candidate)
  }
  return namesByTool
}

/**
 * Convert a harness JSON Schema object into a Zod object for the Agent SDK.
 * Unknown property types accept any JSON value. Extra fields the model sends
 * are kept in the tool arguments.
 * @param parameters - the tool's JSON Schema object.
 * @returns a Zod object schema.
 */
export function toolInputSchema(parameters: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  const required = new Set(Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === 'string')
    : [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) continue
    const field = jsonField(value.type)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return z.object(shape).loose()
}

/**
 * JSON text for one tool call's arguments.
 * @param args - the value the SDK parsed.
 * @returns a JSON object string.
 */
export function argumentsText(args: unknown): string {
  return isRecord(args) ? JSON.stringify(args) : '{}'
}

function jsonField(type: unknown): z.ZodType {
  if (type === 'string') return z.string()
  if (type === 'number' || type === 'integer') return z.number()
  if (type === 'boolean') return z.boolean()
  if (type === 'array') return z.array(z.unknown())
  if (type === 'object') return z.record(z.string(), z.unknown())
  return z.unknown()
}
