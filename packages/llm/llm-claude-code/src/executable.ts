/** Locate the user's Claude Code executable without reading its configuration or credentials. */

import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Where the Claude Code program was found, or why it was not. */
export type ClaudeExecutableLookup =
  | { kind: 'found'; path: string }
  | { kind: 'missing' }
  | { kind: 'override-invalid' }

/**
 * Find an executable `claude` on `PATH`, or the file named by `DSH_CLAUDE_PATH`.
 * This checks only the executable bit. It does not open Claude Code's files.
 * @param env - the environment to search. `DSH_CLAUDE_PATH` wins and does not fall back to `PATH`.
 * @param platform - the path style to use. Defaults to the current process.
 * @returns the executable, a missing installation, or an unusable override.
 */
export function findClaudeExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ClaudeExecutableLookup {
  const override = env.DSH_CLAUDE_PATH
  if (override !== undefined && override.length > 0) {
    return isExecutable(override) ? { kind: 'found', path: override } : { kind: 'override-invalid' }
  }
  const names = platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude']
  const separator = platform === 'win32' ? ';' : delimiter
  for (const dir of (env.PATH ?? '').split(separator)) {
    if (dir.length === 0) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return { kind: 'found', path: candidate }
    }
  }
  return { kind: 'missing' }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch (error: unknown) {
    // A missing or non-executable path is not an installed Claude Code.
    void error
    return false
  }
}
