// Synthetic fixtures from anomalyco/opencode v2.1.4's Session.Message schema; no personal transcripts or DBs.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeReader } from '../server/live/readers/opencode.ts'
import { OpenCodeLogs, refreshOpenCodeLog } from '../server/live/readers/opencode-log.ts'

const file = '/synthetic/opencode/ses_example.jsonl'
const session = { type: 'session', id: 'ses_example', at: 100 }
const row = (id: string, type: string, data: Record<string, unknown> = {}) => ({ type: 'message', at: 110, message: { id, type, time: { created: 110 }, ...data } })
const lines = (records: unknown[]) => {
  let offset = 0
  return records.map((record) => {
    const text = JSON.stringify(record)
    const item = { text, offset }
    offset += Buffer.byteLength(text) + 1
    return item
  })
}

const tool = (status: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool', id: 'call_1', name: 'bash', time: { created: 115, ...(status === 'completed' ? { completed: 130 } : {}) },
  state: { status, input: { command: 'git status', description: 'Check git status' }, ...extra },
})

describe('OpenCode 2 projection reader', () => {
  test('typed messages, text updates, usage and idle delimit one turn; internal text stays out', () => {
    const reader = new OpenCodeReader()
    const events = reader.parse(lines([
      session,
      row('msg_system', 'system', { text: 'private system instructions' }),
      row('msg_user', 'user', { text: 'Hello' }),
      row('msg_agent', 'assistant', { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Hel' }], finish: 'tool-calls' }),
      row('msg_agent', 'assistant', { content: [{ type: 'text', text: 'Hello back' }], tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } }, time: { created: 111, completed: 140 } }),
      row('msg_idle', 'idle', { outcome: 'succeeded' }),
    ]), file)
    expect(events.filter((e) => e.kind === 'session').map((e) => e.sessionId)).toEqual(['ses_example'])
    expect(events.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['Hello'])
    expect(events.filter((e) => e.kind === 'agent').map((e) => [e.id, e.text])).toEqual([
      ['opencode-msg_agent', 'Hel'], ['opencode-msg_agent', 'Hello back'],
    ])
    expect(events.filter((e) => e.kind === 'usage').map((e) => e.tokens)).toEqual([42])
    expect(events.filter((e) => e.kind === 'turn-start')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turn-end')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('private')
  })

  test('tool starts and completions are stable across projection updates and point to the result row', () => {
    const input = lines([
      session,
      row('msg_user', 'user', { text: 'Check the tree' }),
      row('msg_tool', 'assistant', { content: [tool('running')] }),
      row('msg_tool', 'assistant', { content: [tool('running')] }),
      row('msg_tool', 'assistant', { content: [tool('completed', { content: [{ type: 'text', text: 'clean' }] })] }),
    ])
    const reader = new OpenCodeReader()
    const events = reader.parse(input, file)
    const start = events.find((e) => e.kind === 'step')
    const end = events.find((e) => e.kind === 'step-end')
    expect(start?.id).toBe('opencode-tool-call_1')
    expect(events.filter((e) => e.kind === 'step')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'step-end')).toHaveLength(1)
    expect(end?.kind === 'step-end' && end.out).toEqual({ file, offset: input[4].offset })
    expect(reader.parse(input, file).filter((e) => ['step', 'step-end', 'user'].includes(e.kind))).toHaveLength(0)
  })

  test('question tools keep their choices until their result is projected', () => {
    const question = { ...tool('running'), id: 'q1', name: 'question', state: { status: 'running', input: { questions: [{ question: 'Which?', header: 'Target', multiple: true, options: [{ label: 'A', description: 'First' }] }] } } }
    const reader = new OpenCodeReader()
    const events = reader.parse(lines([
      row('msg_q', 'assistant', { content: [question] }),
      row('msg_q', 'assistant', { content: [{ ...question, state: { ...question.state, status: 'completed' } }] }),
    ]), file)
    const asked = events.find((e) => e.kind === 'question')
    expect(asked?.kind === 'question' && asked.items).toEqual([{ header: 'Target', question: 'Which?', options: [{ label: 'A', description: 'First' }], multiSelect: true, allowCustom: true }])
    expect(events.filter((e) => e.kind === 'answered').map((e) => e.id)).toEqual(['opencode-tool-q1'])
  })

  test('every line partition produces the same event sequence, and reset permits a clean replay', () => {
    const input = lines([session, row('msg_u', 'user', { text: 'Unicode café 🚀' }), row('msg_a', 'assistant', { content: [{ type: 'text', text: 'Done' }] }), row('msg_i', 'idle', { outcome: 'succeeded' })])
    const expected = new OpenCodeReader().parse(input, file)
    for (let split = 0; split <= input.length; split++) {
      const reader = new OpenCodeReader()
      expect([...reader.parse(input.slice(0, split), file), ...reader.parse(input.slice(split), file)]).toEqual(expected)
      reader.reset(file)
      expect(reader.parse(input, file)).toEqual(expected)
    }
  })

  test('malformed and future records are ignored; idle failures preserve diagnostics', () => {
    const reader = new OpenCodeReader()
    const events = reader.parse([{ text: '{', offset: 0 }, { text: 'null', offset: 2 }, ...lines([row('msg_future', 'future'), row('msg_error', 'idle', { outcome: 'failed', error: { type: 'APIError', data: { message: 'Rate limited', statusCode: 429 } } })])], file)
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ text: 'Rate limited', code: 'APIError', status: 429 })
    expect(events.filter((e) => e.kind === 'turn-end')).toHaveLength(1)
  })

  test('replayed history and a late completed reply update never reopen its finished turn', () => {
    const input = lines([session, row('msg_u', 'user', { text: 'Hello' }), row('msg_a', 'assistant', { content: [{ type: 'text', text: 'Done' }] }), row('msg_i', 'idle', { outcome: 'succeeded' })])
    const reader = new OpenCodeReader()
    reader.parse(input, file)
    expect(reader.parse(input, file)).toEqual([])
    const revised = reader.parse(lines([row('msg_a', 'assistant', { content: [{ type: 'text', text: 'Done, with details' }], time: { created: 110, completed: 120 } })]), file)
    expect(revised.map((event) => event.kind)).toEqual(['agent'])
  })
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function database(rows = 256) {
  const dir = mkdtempSync(join(tmpdir(), 'shep-opencode-'))
  dirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`)
  db.query('INSERT INTO session_v2 VALUES (?, ?, NULL, ?, NULL)').run('ses_example', '/project', 100)
  const cacheDir = join(dir, 'cache')
  const logs = new OpenCodeLogs({ database: path, cacheDir, rows })
  const put = (id: string, type: string, seq: number, data: Record<string, unknown>) => db.query('INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(id, 'ses_example', type, seq, 110 + seq, JSON.stringify(data))
  return { db, path, logs, put, dir, cacheDir }
}

describe('OpenCode SQLite materialization', () => {
  test('pages the indexed projection, resumes its cursor, and writes private caches without touching source', () => {
    const f = database(1)
    try {
      f.put('msg_u', 'user', 0, { text: 'Hello' })
      f.put('msg_a', 'assistant', 1, { content: [{ type: 'text', text: 'Done' }], time: { created: 111, completed: 112 } })
      const before = readFileSync(f.path)
      const cache = f.logs.find('/project', 90)!
      expect(readFileSync(cache, 'utf8').trim().split('\n')).toHaveLength(2)
      f.logs.refresh(cache)
      const contents = readFileSync(cache, 'utf8')
      expect(contents.trim().split('\n')).toHaveLength(3)
      const resumed = new OpenCodeLogs({ database: f.path, cacheDir: f.cacheDir })
      resumed.refresh(cache)
      expect(readFileSync(cache, 'utf8')).toBe(contents)
      expect(readFileSync(f.path)).toEqual(before)
      expect(statSync(cache).mode & 0o777).toBe(0o600)
      expect(statSync(f.cacheDir).mode & 0o777).toBe(0o700)
    } finally { f.db.close() }
  })

  test('refreshes in-flight messages and pins explicit sessions despite newer unrelated sessions', () => {
    const f = database()
    try {
      f.put('msg_a', 'assistant', 0, { content: [{ type: 'text', text: 'Partial' }], time: { created: 110 } })
      const cache = f.logs.find('/project', 90, 'ses_example')!
      f.put('msg_a', 'assistant', 0, { content: [{ type: 'text', text: 'Finished' }], time: { created: 110, completed: 120 } })
      f.logs.refresh(cache)
      expect(readFileSync(cache, 'utf8')).toContain('Finished')
      const complete = readFileSync(cache, 'utf8')
      f.logs.refresh(cache)
      expect(readFileSync(cache, 'utf8')).toBe(complete)
      f.db.query('INSERT INTO session_v2 VALUES (?, ?, NULL, ?, NULL)').run('ses_new', '/project', 200)
      f.db.query('INSERT INTO session_v2 VALUES (?, ?, ?, ?, NULL)').run('ses_child', '/project', 'ses_new', 300)
      expect(f.logs.sessionId(f.logs.find('/project', 150, 'ses_example')!)).toBe('ses_example')
      expect(f.logs.sessionId(f.logs.find('/project', 150)!)).toBe('ses_new')
      expect(f.logs.find('/project', 0, 'ses_missing')).toBeUndefined()
      expect(f.logs.find('/project', 0, 'ses_child')).toBeUndefined()
      expect(f.logs.find('/project', 0, '../../unrelated')).toBeUndefined()
      expect(f.logs.find('/another-project', 0, 'ses_example')).toBeUndefined()
      expect(f.logs.find('/another-project')).toBeUndefined()
      expect(f.logs.sessionId('/unrelated/ses_new.jsonl')).toBeUndefined()
    } finally { f.db.close() }
  })

  test('repairs an interrupted JSONL append before bounded replay without losing the next complete row', () => {
    const f = database(1)
    try {
      f.put('msg_u', 'user', 0, { text: 'Hello' })
      f.put('msg_a', 'assistant', 1, { content: [{ type: 'text', text: 'Done' }], time: { created: 111, completed: 120 } })
      const cache = f.logs.find('/project')!
      f.logs.refresh(cache)
      const originalMode = statSync(cache).mode & 0o777
      const partial = Buffer.from('{"type":"message","message":{"text":"unfinished 🚀')
      appendFileSync(cache, partial.subarray(0, partial.length - 1))
      f.put('msg_i', 'idle', 2, { outcome: 'succeeded' })
      for (let page = 0; page < 4; page++) f.logs.refresh(cache)
      const records = readFileSync(cache, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(records.some((record) => record.message?.id === 'msg_i')).toBe(true)
      expect(readFileSync(cache, 'utf8')).not.toContain('unfinished')
      const events = new OpenCodeReader().parse(lines(records), file)
      expect(events.filter((event) => event.kind === 'user')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'agent')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'turn-end')).toHaveLength(1)
      expect(statSync(cache).mode & 0o777).toBe(originalMode)
    } finally { f.db.close() }
  })

  test('repairs a partial first line and refuses an incomplete tail beyond the scan bound', () => {
    const f = database()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      f.put('msg_u', 'user', 0, { text: 'Hello' })
      const cache = f.logs.find('/project')!
      writeFileSync(cache, '{"type":')
      f.logs.refresh(cache)
      const records = readFileSync(cache, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(records[0]).toMatchObject({ type: 'session', id: 'ses_example' })
      expect(records[1].message.id).toBe('msg_u')
      appendFileSync(cache, 'x'.repeat((1 << 20) + 8192))
      const size = statSync(cache).size
      expect(f.logs.refresh(cache)).toBe(false)
      expect(statSync(cache).size).toBe(size)
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore(); f.db.close() }
  })

  test('a complete lost trailing line invalidates its advanced cursor and is recovered', () => {
    const f = database()
    try {
      f.put('msg_u', 'user', 0, { text: 'Hello' })
      f.put('msg_a', 'assistant', 1, { content: [{ type: 'text', text: 'Recovered' }], time: { created: 111, completed: 120 } })
      const cache = f.logs.find('/project')!
      const original = readFileSync(cache, 'utf8').trimEnd().split('\n')
      writeFileSync(cache, `${original.slice(0, -1).join('\n')}\n`)
      f.logs.refresh(cache)
      const contents = readFileSync(cache, 'utf8')
      expect(contents).toContain('Recovered')
      const cursor = JSON.parse(readFileSync(`${cache}.cursor.json`, 'utf8'))
      expect(cursor.bytes).toBe(statSync(cache).size)
      const reader = new OpenCodeReader()
      const events = reader.parse(lines(contents.trim().split('\n').map((line) => JSON.parse(line))), file)
      expect(events.filter((event) => event.kind === 'user')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'agent')).toHaveLength(1)
      delete cursor.bytes
      writeFileSync(`${cache}.cursor.json`, JSON.stringify(cursor))
      f.logs.refresh(cache)
      expect(JSON.parse(readFileSync(`${cache}.cursor.json`, 'utf8')).bytes).toBe(statSync(cache).size)
    } finally { f.db.close() }
  })

  test('a concurrent WAL completion and idle marker share one materialization snapshot', () => {
    const f = database()
    let restore = () => {}
    try {
      f.db.exec('PRAGMA journal_mode = WAL')
      f.put('msg_u', 'user', 0, { text: 'Hello' })
      f.put('msg_a', 'assistant', 1, { content: [{ type: 'text', text: 'Partial' }], time: { created: 111 } })
      const cache = f.logs.find('/project')!
      const original = Database.prototype.query
      let committed = false
      const intercept = spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
        const statement = Reflect.apply(original, this, [sql]) as ReturnType<typeof original>
        if (sql.includes('FROM session_message WHERE id = ? AND session_id = ?')) {
          const get = statement.get
          statement.get = (...parameters) => {
            const result = Reflect.apply(get, statement, parameters)
            if (!committed) {
              committed = true
              f.put('msg_a', 'assistant', 1, { content: [{ type: 'text', text: 'Finished' }], time: { created: 111, completed: 120 } })
              f.put('msg_i', 'idle', 2, { outcome: 'succeeded' })
            }
            return result
          }
        }
        return statement
      } as typeof original)
      restore = () => intercept.mockRestore()
      f.logs.refresh(cache)
      restore()
      expect(committed).toBe(true)
      expect(readFileSync(cache, 'utf8')).not.toContain('msg_i')
      f.logs.refresh(cache)
      const records = readFileSync(cache, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const completed = records.findIndex((record) => record.message?.id === 'msg_a' && record.message?.time?.completed === 120)
      const idle = records.findIndex((record) => record.message?.id === 'msg_i')
      expect(completed).toBeGreaterThan(0)
      expect(idle).toBeGreaterThan(completed)
      const events = new OpenCodeReader().parse(lines(records), file)
      expect(events.filter((event) => event.kind === 'turn-start')).toHaveLength(1)
      expect(events.filter((event) => event.kind === 'turn-end')).toHaveLength(1)
    } finally { restore(); f.db.close() }
  })

  test('oversized records have bounded diagnostic output; unsupported schemas fail without a write', () => {
    const f = database()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      f.put('msg_large', 'assistant', 0, { content: [{ type: 'text', text: 'x'.repeat((1 << 20) + 1) }] })
      const cache = f.logs.find('/project')!
      const contents = readFileSync(cache, 'utf8')
      expect(contents.length).toBeLessThan(1000)
      expect(contents).toContain('1 MiB cache limit')
      f.db.exec('DROP TABLE session_message')
      expect(f.logs.find('/project')).toBeUndefined()
      expect(warn).toHaveBeenCalled()
      expect(readFileSync(cache, 'utf8')).toBe(contents)
    } finally { warn.mockRestore(); f.db.close() }
  })

  test('a remote worker never refreshes a cache from the main machine native database', () => {
    const previous = process.env.SHEPHERDR_BOX
    process.env.SHEPHERDR_BOX = 'remote-worker'
    try { expect(refreshOpenCodeLog(file)).toBe(false) }
    finally { if (previous === undefined) delete process.env.SHEPHERDR_BOX; else process.env.SHEPHERDR_BOX = previous }
  })
})
