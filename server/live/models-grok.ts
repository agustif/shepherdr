// Grok's human-readable catalog has a Default model line and an Available models list. Authentication notices
// may precede it; only entries in that list are models. No per-model effort capability is exposed by this command.
import type { CliModels } from './models.ts'

export function parseGrok(output: string): CliModels | undefined {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'Available models:')
  if (start < 0) return undefined
  const ids = [...new Set(lines.slice(start + 1).flatMap((line) => line.match(/^\s*[*-]\s+([\w./:@+-]+)(?:\s+\(default\))?\s*$/)?.[1] ?? []))]
  if (!ids.length) return undefined
  const selected = output.match(/^Default model:\s*(\S+)\s*$/m)?.[1]
  return { models: ids.map((id) => ({ id, label: id, efforts: [] })), efforts: [], ...(selected && ids.includes(selected) ? { default: selected } : {}) }
}
