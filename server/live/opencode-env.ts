// OpenCode 2's full TUI takes its initial model through config, not --model. A private server reads this scoped
// environment when it starts; user config on disk stays intact, including explicit permission denials.
export function openCodeEnv(model: string | undefined, env: Record<string, string>, inherited?: string): Record<string, string> {
  if (!model || model === 'default') return env
  const content = env.OPENCODE_CONFIG_CONTENT ?? inherited
  let config: Record<string, unknown> = {}
  if (content) {
    try {
      const value: unknown = JSON.parse(content)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
      config = value as Record<string, unknown>
    } catch {
      throw new Error('Cannot select an OpenCode model: OPENCODE_CONFIG_CONTENT must contain a JSON object.')
    }
  }
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, model }) }
}
