/** Shared object check for Claude Code reports and tool arguments. */

/**
 * Whether a value is a non-array object.
 * @param value - the candidate.
 * @returns true when the value is a record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
