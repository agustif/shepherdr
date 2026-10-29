// OpenCode 2's session_message projection, materialized by opencode-log.ts. The pinned schema is
// anomalyco/opencode v2.1.4, packages/schema/src/session-message.ts. Assistant rows change in place while
// streaming; their stable message/tool ids make those changes updates, never another reply or tool call.
import { claudeStep, codexCall } from './steps.ts'
import type { CliQuestionItem, LogEvent, Reader } from './types.ts'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const text = (value: unknown): string => typeof value === 'string' ? value : ''

interface FileState {
  session?: string
  turn: boolean
  seen: Set<string>
  replies: Map<string, string>
  calls: Set<string>
  ended: Set<string>
  questions: Set<string>
}

const state = (): FileState => ({ turn: false, seen: new Set(), replies: new Map(), calls: new Set(), ended: new Set(), questions: new Set() })

/** Reuse the same descriptions and sizing as the other readers, translating OpenCode's input field names. */
function step(name: string, input: Json) {
  const names: Record<string, string> = { bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', glob: 'Glob', grep: 'Grep', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task' }
  return claudeStep(names[name] ?? name, {
    ...input,
    file_path: input.filePath,
    old_string: input.oldString,
    new_string: input.newString,
    subagent_type: input.subagent_type,
  }) ?? codexCall(name, input)
}

function questions(input: Json): CliQuestionItem[] {
  return list(input.questions).map(object).filter((q) => text(q.question).trim()).map((q) => ({
    header: text(q.header) || undefined,
    question: text(q.question),
    options: list(q.options).map(object).filter((o) => text(o.label)).map((o) => ({ label: text(o.label), description: text(o.description) || undefined })),
    multiSelect: q.multiple === true,
    allowCustom: q.custom !== false,
  }))
}

function failure(value: unknown): { text: string; code?: string; status?: number } {
  const e = object(value)
  const data = object(e.data)
  return {
    text: text(e.message) || text(data.message) || text(e.type) || 'OpenCode request failed',
    code: text(e.type) || text(e.name) || undefined,
    status: number(e.status) || number(e.statusCode) || number(data.statusCode) || undefined,
  }
}

export class OpenCodeReader implements Reader {
  cli = 'opencode'
  private files = new Map<string, FileState>()

  reset(file: string) {
    this.files.delete(file)
  }

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    let s = this.files.get(file)
    if (!s) this.files.set(file, s = state())
    const out: LogEvent[] = []
    for (const line of lines) {
      let row: Json
      try { row = object(JSON.parse(line.text)) } catch { continue }
      if (row.type === 'session') {
        const id = text(row.id)
        if (id && s.session !== id) {
          s.session = id
          out.push({ kind: 'session', id: `opencode-session-${id}`, sessionId: id, at: number(row.at) })
        }
        continue
      }
      if (row.type !== 'message') continue
      const m = object(row.message)
      const sourceId = text(m.id)
      if (!sourceId) continue
      const id = `opencode-${sourceId}`
      const time = object(m.time)
      const at = number(time.created) || number(row.at)
      const once = (key: string) => {
        if (s.seen.has(key)) return false
        s.seen.add(key)
        return true
      }
      if (m.type === 'user') {
        if (!once(id)) continue
        s.turn = true
        out.push({ kind: 'turn-start', id: `start-${id}`, at })
        const words = text(m.text).trim()
        if (words) out.push({ kind: 'user', id, at, text: words })
      } else if (m.type === 'assistant') {
        // Remember the message even when its user's turn is already open. A cache replay or late projection
        // revision after idle updates that reply in place; it must never manufacture another turn.
        const first = once(`start-${id}`)
        if (!s.turn && first) {
          s.turn = true
          out.push({ kind: 'turn-start', id: `start-${id}`, at })
        }
        const content = list(m.content).map(object)
        const words = content.filter((c) => c.type === 'text').map((c) => text(c.text).trim()).filter(Boolean).join('\n\n')
        if (words && s.replies.get(id) !== words) {
          s.replies.set(id, words)
          out.push({ kind: 'agent', id, at, text: words })
        }
        const usage = object(m.tokens)
        const cache = object(usage.cache)
        const tokens = number(usage.input) + number(usage.output) + number(usage.reasoning) + number(cache.read) + number(cache.write)
        if (tokens > 0) out.push({ kind: 'usage', id: `usage-${id}`, at, tokens })
        if (m.error && once(`error-${id}`)) out.push({ kind: 'error', id: `error-${id}`, at, ...failure(m.error) })
        for (const c of content) {
          if (c.type !== 'tool' || !text(c.id) || !text(c.name)) continue
          const call = `opencode-tool-${text(c.id)}`
          const name = text(c.name)
          const toolState = object(c.state)
          if (toolState.status === 'streaming') continue
          const input = object(toolState.input)
          const toolTime = object(c.time)
          const started = number(toolTime.created) || at
          const completed = number(toolTime.completed) || number(time.completed) || at
          const ended = toolState.status === 'completed' || toolState.status === 'error'
          if (name === 'question') {
            if (!s.questions.has(call) && !ended) {
              const items = questions(input)
              if (items.length) {
                s.questions.add(call)
                out.push({ kind: 'question', id: call, at: started, tool: name, items })
              }
            }
            if (ended && s.questions.delete(call)) out.push({ kind: 'answered', id: call, at: completed })
            continue
          }
          const output = { file, offset: line.offset }
          if (!s.calls.has(call)) {
            s.calls.add(call)
            out.push({ kind: 'step', id: call, at: started, tool: name, ...step(name, input), ...(ended ? { end: completed, failed: toolState.status === 'error', out: output } : {}) })
            if (ended) s.ended.add(call)
          } else if (ended && !s.ended.has(call)) {
            s.ended.add(call)
            out.push({ kind: 'step-end', id: call, at: completed, failed: toolState.status === 'error', out: output })
          }
        }
      } else if (m.type === 'idle' && once(id)) {
        if (m.error) out.push({ kind: 'error', id: `error-${id}`, at, ...failure(m.error) })
        s.turn = false
        out.push({ kind: 'turn-end', id, at })
      }
    }
    return out
  }
}
