/**
 * Environment for the unmodified Claude Code process.
 * Credential variables are removed so this process does not forward them.
 * Claude Code reads its own login from the user's home directory.
 */

/** Credential variables this process must not pass into Claude Code. */
const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MCP_TOOL_TIMEOUT',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
] as const

/** Isolation flags that keep the process off Claude Code's own tools, memory, and compaction. */
const ISOLATION: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTO_COMPACT: '1',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  ENABLE_TOOL_SEARCH: 'false',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
}

/**
 * Build the environment passed to Claude Code.
 * `Options.env` replaces the child environment, so `PATH` and `HOME` are copied
 * and the isolation flags are then applied. `CLAUDE_AGENT_SDK_CLIENT_APP` is not set.
 * @param parent - the environment to copy. Defaults to `process.env`.
 * @returns a string environment with credential variables removed.
 */
export function claudeChildEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (typeof value !== 'string') continue
    if ((STRIPPED as readonly string[]).includes(key)) continue
    env[key] = value
  }
  return { ...env, ...ISOLATION }
}
