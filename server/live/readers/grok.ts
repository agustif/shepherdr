// Grok Build 1.0.70 persists ACP notifications in updates.jsonl, wrapped with a seconds timestamp and method.
// Text chunks are deltas. Keep their stable message id across incremental reads; tool calls and new streams split replies.
import { words, testResult } from '../../../shared/activity.ts'
import { baseName, commandSay } from './steps.ts'
import type { CliQuestionItem, LogEvent, Reader } from './types.ts'

type Json = Record<string, any>
interface FileState {
  session: string
  offset: number
  turn?: string
  message?: { id: string; key: string; text: string }
  user?: { id: string; key: string; text: string }
  tools: Map<string, ReturnType<typeof toolWords>>
  questions: Set<string>
}

const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const textContent = (value: unknown): string => {
  const c = object(value)
  return c.type === 'text' ? string(c.text) : ''
}

// ACP schema 0.11.4 has end_turn, cancelled, max_tokens, max_turn_requests and refusal. Grok adds error/rate_limit.
// Only end_turn succeeds; cancellation is intentional. Every other terminal must reach retry/cut-off handling.
const STOP_ERRORS: Record<string, { text: string; code?: string; status?: number }> = {
  rate_limit: { text: 'Grok was rate limited.', code: 'rate_limit', status: 429 },
  max_tokens: { text: 'Grok reached its maximum output tokens.', code: 'max_output_tokens' },
  max_turn_requests: { text: 'Grok reached its maximum requests for this turn.', code: 'max_turn_requests' },
  refusal: { text: 'Grok refused to continue this request.', code: 'invalid_request' },
}

function toolWords(update: Json) {
  const meta = object(object(update._meta)['x.ai/tool'])
  const input = object(update.rawInput)
  const tool = string(meta.name) || string(update.title) || 'Tool'
  const kind = string(meta.kind || update.kind).toLowerCase()
  const path = string(input.target_file || input.file_path || input.path || object(meta.input).path)
  if (tool === 'run_terminal_command' || kind === 'execute') return { tool, ...commandSay(string(input.command || object(meta.input).command)) }
  const step = /read/.test(kind) ? 'read' : /edit|write|delete|move/.test(kind) ? 'edit' : /search|list/.test(kind) ? 'search' : /fetch|web/.test(kind) ? 'web' : /agent/.test(kind) ? 'agent' : 'other'
  const action = step === 'read' ? 'Read' : step === 'edit' ? 'Edit' : step === 'search' ? 'Search' : step === 'web' ? 'Fetch' : 'Run'
  return { tool, step, ...words(`${action} ${path ? baseName(path) : tool}`, path ? baseName(path) : '', { detail: path || string(update.title) }) } as const
}

function questions(input: Json): CliQuestionItem[] {
  return (Array.isArray(input.questions) ? input.questions : []).flatMap((value: unknown) => {
    const q = object(value)
    if (!string(q.question)) return []
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((option: unknown) => {
      const o = object(option)
      return string(o.label) ? [{ label: string(o.label), description: string(o.description) || undefined }] : []
    })
    return [{ question: string(q.question), options, multiSelect: q.multi_select === true || q.multiSelect === true, allowCustom: true }]
  })
}

export class GrokReader implements Reader {
  cli = 'grok'
  private files = new Map<string, FileState>()

  reset(file: string) {
    this.files.delete(file)
  }

  parse(lines: { text: string; offset: number }[], file: string): LogEvent[] {
    const out: LogEvent[] = []
    for (const { text, offset } of lines) {
      let line: Json
      try { line = object(JSON.parse(text)) } catch { continue }
      if (line.method !== 'session/update' && line.method !== '_x.ai/session/update') continue
      const params = object(line.params)
      const update = object(params.update)
      const type = string(update.sessionUpdate)
      const session = string(params.sessionId)
      if (!type || !session) continue
      const meta = object(params._meta)
      const at = number(meta.agentTimestampMs) || number(line.timestamp) * 1000
      let state = this.files.get(file)
      if (!state) {
        state = { session, offset: -1, tools: new Map(), questions: new Set() }
        this.files.set(file, state)
        out.push({ kind: 'session', id: `session-${session}`, sessionId: session, at })
      }
      if (state.session !== session || offset <= state.offset) continue
      state.offset = offset
      const id = string(meta.eventId) || `grok-${session}-${offset}`
      const prompt = string(meta.promptId || update.prompt_id) || state.turn || id
      if (!state.turn && (type === 'agent_message_chunk' || type === 'tool_call')) {
        state.turn = prompt
        out.push({ kind: 'turn-start', id: `start-${prompt}`, at })
      }

      if (type === 'user_message_chunk') {
        const content = object(update.content)
        const text = string(object(content._meta).displayText) || textContent(content)
        if (!text) continue
        const index = object(update._meta).promptIndex
        const key = typeof index === 'number' ? `prompt-${index}` : id
        if (!state.user || state.user.key !== key) {
          state.user = { id, key, text: '' }
          state.turn = id
          state.message = undefined
          out.push({ kind: 'turn-start', id: `start-${id}`, at })
        }
        state.user.text += text
        if (state.user.text.trim()) out.push({ kind: 'user', id: state.user.id, text: state.user.text.trim(), at })
      } else if (type === 'agent_message_chunk') {
        const text = textContent(update.content)
        if (!text) continue
        state.user = undefined
        const key = `${prompt}:${number(meta.streamStartMs)}`
        if (!state.message || state.message.key !== key) state.message = { id, key, text: '' }
        state.message.text += text
        if (state.message.text.trim()) out.push({ kind: 'agent', id: state.message.id, text: state.message.text.trim(), at })
      } else if (type === 'tool_call' || type === 'tool_call_update') {
        state.message = undefined
        state.user = undefined
        const call = string(update.toolCallId)
        if (!call) continue
        const tool = string(object(object(update._meta)['x.ai/tool']).name)
        const prior = state.tools.get(call)
        const current = toolWords(update)
        const described = prior && !tool && !update.rawInput ? prior : { ...current, test: prior?.test || current.test }
        const items = tool === 'ask_user_question' || tool === 'AskUserQuestion' ? questions(object(update.rawInput)) : []
        if (items.length && !state.questions.has(call)) {
          state.questions.add(call)
          out.push({ kind: 'question', id: call, at, tool: 'AskUserQuestion', items })
        } else if (!state.questions.has(call) && (type === 'tool_call' || update.rawInput || update.title)) {
          state.tools.set(call, described)
          out.push({ kind: 'step', id: call, at, ...described })
        }
        const status = string(update.status).toLowerCase()
        if (status === 'completed' || status === 'failed') {
          if (state.questions.delete(call)) out.push({ kind: 'answered', id: call, at })
          else {
            const blocks: unknown[] = Array.isArray(update.content) ? update.content : []
            const raw = string(update.rawOutput) || blocks.map((block) => textContent(object(block).content ?? block)).filter(Boolean).join('\n')
            out.push({ kind: 'step-end', id: call, at, failed: status === 'failed', out: { file, offset }, result: state.tools.get(call)?.test ? testResult(raw) : undefined })
          }
          state.tools.delete(call)
        }
      } else if (type === 'turn_completed') {
        const result = string(update.agent_result).trim()
        const stop = string(update.stop_reason).toLowerCase()
        // A successful terminal can finish an earlier partial reply. Error terminals carry an error detail instead.
        if (stop === 'end_turn' && result && result !== state.message?.text.trim()) out.push({ kind: 'agent', id: state.message?.id ?? `result-${prompt}`, at, text: result })
        const usage = object(update.usage)
        const tokens = number(usage.totalTokens) || number(usage.inputTokens) + number(usage.outputTokens)
        if (tokens) out.push({ kind: 'usage', id: `usage-${prompt}`, at, tokens })
        if (stop !== 'end_turn' && stop !== 'cancelled') {
          const failure = STOP_ERRORS[stop]
          const code = failure?.code ?? (stop === 'error' ? undefined : stop || 'unknown_stop_reason')
          out.push({ kind: 'error', id: `error-${prompt}`, at, ...(code ? { code } : {}), ...(failure?.status ? { status: failure.status } : {}), text: string(update.error) || result || failure?.text || (stop === 'error' ? 'Grok ended this turn with an error.' : `Grok ended this turn with stop reason: ${stop || 'unknown'}.`) })
        }
        for (const question of state.questions) out.push({ kind: 'answered', id: question, at })
        out.push({ kind: 'turn-end', id: `turn-${prompt}`, at })
        state.message = undefined
        state.user = undefined
        state.turn = undefined
        state.tools.clear()
        state.questions.clear()
      } else if (type === 'subagent_spawned' && string(update.subagent_id)) {
        out.push({ kind: 'job', id: string(update.subagent_id), at, job: 'agent', title: string(update.description) || 'Grok subagent' })
      } else if (type === 'subagent_finished' && string(update.subagent_id)) {
        out.push({ kind: 'job-end', id: string(update.subagent_id), at })
      } else if (type === 'task_backgrounded' && string(update.task_id)) {
        out.push({ kind: 'job', id: string(update.task_id), at, job: 'shell', title: string(update.description) || string(update.command) || 'Background command', step: string(update.tool_call_id) || undefined, output: string(update.output_file) || undefined })
      } else if (type === 'task_completed') {
        const task = object(update.task_snapshot)
        const taskId = string(task.id || task.task_id)
        if (taskId) out.push({ kind: 'job-end', id: taskId, at })
      }
    }
    return out
  }
}
