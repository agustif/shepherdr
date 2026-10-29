// Synthetic ACP records follow Grok Build 1.0.70's durable updates.jsonl format; no private transcripts are fixtures.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokReader } from '../server/live/readers/grok.ts'
import { findGrokLog, grokHome, grokLogPath, grokSessionDir, grokSessionId } from '../server/live/readers/grok-files.ts'
import type { LogEvent } from '../server/live/readers/types.ts'
import { providerError } from '../server/live/retry.ts'

const SESSION = 'b1f0c2d4-0000-4000-8000-000000000001'
const FILE = `/grok/sessions/%2Fwork%2Fapp/${SESSION}/updates.jsonl`
const AT = 1793256000000
const event = (id: string, update: Record<string, unknown>, meta: Record<string, unknown> = {}) => ({
  timestamp: AT / 1000,
  method: ['turn_completed', 'subagent_spawned', 'subagent_finished', 'task_backgrounded', 'task_completed', 'hook_execution'].includes(String(update.sessionUpdate)) ? '_x.ai/session/update' : 'session/update',
  params: { sessionId: SESSION, update, _meta: { eventId: id, agentTimestampMs: AT, ...meta } },
})
const user = (id = 'u1', text = 'Read the package manifest.') => event(id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { promptIndex: 0 } })
const agent = (id: string, text: string, streamStartMs = AT) => event(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, { promptId: 'prompt-1', streamStartMs })
const lines = (records: unknown[]) => {
  let offset = 0
  return records.map((record) => {
    const text = typeof record === 'string' ? record : JSON.stringify(record)
    const line = { text, offset }
    offset += Buffer.byteLength(text) + 1
    return line
  })
}
const latest = (events: LogEvent[], kind: 'agent' | 'user') => [...new Map(events.filter((e) => e.kind === kind).map((e) => [e.id, e])).values()]

describe('Grok durable ACP reader', () => {
  test('joins streamed text, splits at tools, ignores thinking, and reads final usage once', () => {
    const input = lines([
      user(),
      event('thought', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Internal reasoning.' } }),
      agent('a1', 'I will '), agent('a2', 'read it.'),
      event('tool', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read package.json', rawInput: { target_file: '/work/app/package.json' }, _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } } }),
      event('done', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"name":"app"}' } }] }),
      agent('a3', 'The package is '), agent('a4', 'named app.'),
      event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn', usage: { inputTokens: 100, cachedReadTokens: 80, outputTokens: 20, totalTokens: 120 } }),
    ])
    const events = new GrokReader().parse(input, FILE)
    expect(latest(events, 'user')).toEqual([{ kind: 'user', id: 'u1', at: AT, text: 'Read the package manifest.' }])
    expect(latest(events, 'agent')).toEqual([
      { kind: 'agent', id: 'a1', at: AT, text: 'I will read it.' },
      { kind: 'agent', id: 'a3', at: AT, text: 'The package is named app.' },
    ])
    expect(events.find((e) => e.kind === 'step')).toMatchObject({ id: 't1', step: 'read', tool: 'read_file', target: 'package.json' })
    expect(events.find((e) => e.kind === 'step-end')).toMatchObject({ id: 't1', failed: false, out: { file: FILE, offset: input[5].offset } })
    expect(events.filter((e) => e.kind === 'usage')).toEqual([{ kind: 'usage', id: 'usage-prompt-1', at: AT, tokens: 120 }])
    expect(events.at(-1)).toEqual({ kind: 'turn-end', id: 'turn-prompt-1', at: AT })
  })

  test('every incremental partition produces the same events, replay is ignored, and reset permits rereading', () => {
    const input = lines([user(), agent('a1', 'Hello '), agent('a2', 'world.'), event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn' })])
    const expected = new GrokReader().parse(input, FILE)
    for (let split = 0; split <= input.length; split++) {
      const reader = new GrokReader()
      expect([...reader.parse(input.slice(0, split), FILE), ...reader.parse(input.slice(split), FILE)]).toEqual(expected)
      expect(reader.parse(input, FILE)).toEqual([])
      reader.reset(FILE)
      expect(reader.parse(input, FILE)).toEqual(expected)
    }
  })

  test('a final full reply replaces its streamed partial using the original reply id', () => {
    const input = lines([
      user(), agent('a1', 'The package is '),
      event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn', agent_result: 'The package is named app.' }),
    ])
    const reader = new GrokReader()
    const initial = reader.parse(input.slice(0, 2), FILE)
    const terminal = reader.parse(input.slice(2), FILE)
    expect(terminal.find((e) => e.kind === 'agent')).toEqual({ kind: 'agent', id: 'a1', at: AT, text: 'The package is named app.' })
    expect(latest([...initial, ...terminal], 'agent')).toEqual([{ kind: 'agent', id: 'a1', at: AT, text: 'The package is named app.' }])
  })

  test('rate limits become retryable structured errors before the terminal event', () => {
    const events = new GrokReader().parse(lines([
      user(),
      event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'rate_limit', agent_result: null }),
    ]), FILE)
    const error = events.find((e) => e.kind === 'error')!
    expect(error).toEqual({ kind: 'error', id: 'error-prompt-1', at: AT, code: 'rate_limit', status: 429, text: 'Grok was rate limited.' })
    if (error.kind === 'error') expect(providerError(error.text, error.code, error.status)).toEqual({ passing: true, reason: 'Rate limited' })
    expect(events.indexOf(error)).toBeLessThan(events.findIndex((e) => e.kind === 'turn-end'))
  })

  test('non-success stop reasons stay cut off, while intentional cancellation does not trigger retry', () => {
    for (const stop of ['max_tokens', 'max_turn_requests', 'refusal', 'future_failure']) {
      const events = new GrokReader().parse(lines([user(), event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: stop })]), FILE)
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ id: 'error-prompt-1' })
      expect(events.at(-1)).toEqual({ kind: 'turn-end', id: 'turn-prompt-1', at: AT })
    }
    for (const stop of ['end_turn', 'cancelled']) {
      const events = new GrokReader().parse(lines([user(), event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: stop })]), FILE)
      expect(events.some((e) => e.kind === 'error')).toBe(false)
    }
  })

  test('provider error details do not replace or duplicate a partial assistant reply', () => {
    const events = new GrokReader().parse(lines([
      user(), agent('a1', 'Partial answer.'),
      event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'error', agent_result: 'Connection reset.' }),
    ]), FILE)
    expect(latest(events, 'agent')).toEqual([{ kind: 'agent', id: 'a1', at: AT, text: 'Partial answer.' }])
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ text: 'Connection reset.' })
  })

  test('drops malformed records and unknown events, and keeps files and session identities separate', () => {
    const input = lines(['{', null, [], { method: 'other', params: {} }, user(), event('hook', { sessionUpdate: 'hook_execution' }), { ...agent('wrong', 'Other session'), params: { ...agent('wrong', 'Other session').params, sessionId: 'another-session' } }, agent('a1', 'Visible.')])
    const reader = new GrokReader()
    const events = reader.parse(input, FILE)
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1)
    expect(latest(events, 'agent')).toEqual([{ kind: 'agent', id: 'a1', at: AT, text: 'Visible.' }])
    expect(reader.parse(lines([agent('b1', 'A different file.')]), `${FILE}.copy`).some((e) => e.kind === 'agent')).toBe(true)
  })

  test('preserves AskUserQuestion options and closes the card when its tool resolves', () => {
    const records = lines([
      user(),
      event('ask', { sessionUpdate: 'tool_call', toolCallId: 'q1', rawInput: { questions: [{ question: 'Which theme?', options: [{ label: 'Dark', description: 'Dark background' }], multi_select: true }] }, _meta: { 'x.ai/tool': { name: 'ask_user_question', kind: 'other' } } }),
      event('answered', { sessionUpdate: 'tool_call_update', toolCallId: 'q1', status: 'completed' }),
    ])
    const events = new GrokReader().parse(records, FILE)
    expect(events.find((e) => e.kind === 'question')).toEqual({ kind: 'question', id: 'q1', at: AT, tool: 'AskUserQuestion', items: [{ question: 'Which theme?', options: [{ label: 'Dark', description: 'Dark background' }], multiSelect: true, allowCustom: true }] })
    expect(events.at(-1)).toEqual({ kind: 'answered', id: 'q1', at: AT })
  })

  test('keeps tool failures separate from provider turn errors and tracks background agents', () => {
    const events = new GrokReader().parse(lines([
      user(),
      event('call', { sessionUpdate: 'tool_call', toolCallId: 't2', rawInput: { command: 'bun test' }, _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } } }),
      event('failed', { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '2 failed, 3 passed' } }] }),
      event('spawn', { sessionUpdate: 'subagent_spawned', subagent_id: 'child', description: 'Review parser' }),
      event('finished', { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }),
      event('end', { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'error', agent_result: 'Provider unavailable.' }),
    ]), FILE)
    expect(events.find((e) => e.kind === 'step-end')).toMatchObject({ id: 't2', failed: true, result: '2 failed, 3 passed' })
    expect(events.filter((e) => e.kind === 'error')).toEqual([{ kind: 'error', id: 'error-prompt-1', at: AT, text: 'Provider unavailable.' }])
    expect(events.find((e) => e.kind === 'job')).toMatchObject({ id: 'child', job: 'agent', title: 'Review parser' })
    expect(events.find((e) => e.kind === 'job-end')).toMatchObject({ id: 'child' })
  })
})

describe('Grok session discovery', () => {
  test('uses GROK_HOME and RFC 3986 path encoding, accepting only UUID updates paths', () => {
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = '/test/grok'
    try {
      expect(grokHome()).toBe('/test/grok')
      expect(grokSessionDir("/work/a b!'()é")).toBe('/test/grok/sessions/%2Fwork%2Fa%20b%21%27%28%29%C3%A9')
      expect(grokSessionId(grokLogPath('/work/app', SESSION))).toBe(SESSION)
      expect(grokSessionId('/grok/updates.jsonl')).toBeUndefined()
      expect(grokSessionId(`/grok/${SESSION}/chat_history.jsonl`)).toBeUndefined()
    } finally { if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous }
  })

  test('ignores subagents and wrong cwd summaries, observes mtime, and finds long-path metadata', () => {
    const previous = process.env.GROK_HOME
    const root = mkdtempSync(join(tmpdir(), 'shepherdr-grok-'))
    process.env.GROK_HOME = root
    try {
      const cwd = '/work/app'
      const add = (id: string, modified: number, extra: object = {}) => {
        const file = grokLogPath(cwd, id)
        mkdirSync(join(grokSessionDir(cwd), id), { recursive: true })
        writeFileSync(file, '')
        writeFileSync(join(grokSessionDir(cwd), id, 'summary.json'), JSON.stringify({ info: { id, cwd }, ...extra }))
        utimesSync(file, modified / 1000, modified / 1000)
        return file
      }
      const main = add(SESSION, 1000)
      add('b1f0c2d4-0000-4000-8000-000000000002', 2000, { session_kind: 'subagent' })
      add('b1f0c2d4-0000-4000-8000-000000000003', 3000, { info: { cwd: '/other', id: 'b1f0c2d4-0000-4000-8000-000000000003' } })
      expect(findGrokLog(cwd)).toBe(main)
      expect(findGrokLog(cwd, 1001)).toBeUndefined()
      const long = `/work/${'long-path/'.repeat(40)}app`
      const hashed = join(root, 'sessions', 'app-0123456789abcdef')
      mkdirSync(hashed, { recursive: true })
      writeFileSync(join(hashed, '.cwd'), long)
      expect(grokSessionDir(long)).toBe(hashed)
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
