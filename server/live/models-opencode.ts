// `opencode models` emits provider/model identifiers, one per line. It does not advertise effort variants;
// leave those to the CLI instead of presenting effort levels a provider may not accept.
import type { CliModels } from './models.ts'

export function parseOpenCode(output: string): CliModels | undefined {
  const ids = [...new Set(output.split('\n').map((line) => line.trim()).filter((line) => /^[\w.-]+\/[^\s]+$/.test(line)))]
  return ids.length ? { models: ids.map((id) => ({ id, label: id, efforts: [] })), efforts: [] } : undefined
}
