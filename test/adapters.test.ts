// Shared integration around the native readers: isolated config, stable session identity, and tool output.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'shep-adapters-'))
process.env.SHEPHERDR_HOME = dir
const { uniqueLogs } = await import('../server/live/agents.ts')
const { openCodeEnv } = await import('../server/live/opencode-env.ts')
const { outputAt } = await import('../server/live/activity.ts')
const { readerFor } = await import('../server/live/readers/index.ts')
const { sessionIdForLog } = await import('../server/live/readers/find.ts')
const { openCodeMenu } = await import('../server/live/opencode-menu.ts')
const { startsSession } = await import('../server/live/commands.ts')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('native agent integration', () => {
  test('OpenCode sign-in dialogs hold messages even when herdr reports idle', () => {
    expect(openCodeMenu('     Connect an integration              esc\n\n     No integrations found\n')).toMatchObject({ title: 'Connect an integration in OpenCode', choices: [] })
    expect(openCodeMenu('The docs say Connect an integration, then press esc.')).toBeNull()
    expect(openCodeMenu('Connect an integration\nA normal response without a modal close control')).toBeNull()
  })
  test('new-session commands trigger native log discovery for both added CLIs', () => {
    expect(startsSession('opencode', '/new')).toBe(true)
    expect(startsSession('grok', '/new')).toBe(true)
    expect(startsSession('grok', '/resume')).toBe(true)
    expect(startsSession('opencode', '/model')).toBe(false)
  })
  test('OpenCode model config keeps inherited permissions and never mutates its input', () => {
    const env = { SHEPHERDR_CHAT: 'chat', OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' }, model: 'old/model' }) }
    const before = { ...env }
    const scoped = openCodeEnv('new/model', env)
    expect(JSON.parse(scoped.OPENCODE_CONFIG_CONTENT)).toEqual({ permission: { '*': 'deny' }, model: 'new/model' })
    expect(env).toEqual(before)
    expect(openCodeEnv('default', env)).toBe(env)
    expect(openCodeEnv(undefined, env)).toBe(env)
    expect(JSON.parse(openCodeEnv('new/model', {}, '{"theme":"dark"}').OPENCODE_CONFIG_CONTENT)).toEqual({ theme: 'dark', model: 'new/model' })
    for (const invalid of ['[]', 'null', 'broken']) expect(() => openCodeEnv('new/model', { OPENCODE_CONFIG_CONTENT: invalid })).toThrow('JSON object')
  })
  test('each Grok session survives the shared updates.jsonl filename', () => {
    const one = '01234567-89ab-cdef-0123-456789abcdef'
    const two = '11234567-89ab-cdef-0123-456789abcdef'
    const logs = [`/home/.grok/sessions/cwd/${one}/updates.jsonl`, `/home/.grok/sessions/cwd/${two}/updates.jsonl`]
    expect(uniqueLogs(logs)).toEqual(logs)
    expect(uniqueLogs([logs[0], logs[1], `/mirror${logs[0]}`])).toEqual([`/mirror${logs[0]}`, logs[1]])
    expect(sessionIdForLog('grok', logs[0])).toBe(one)
  })
  test('the reader registry retains the original readers and includes both new CLIs', () => {
    for (const cli of ['claude', 'codex', 'pi', 'opencode', 'grok']) expect(readerFor(cli)?.cli).toBe(cli)
    expect(readerFor('unknown')).toBeUndefined()
  })
  test('tool output is read from the matching OpenCode or Grok call only', () => {
    const file = join(dir, 'output.jsonl')
    const read = (line: unknown, id: string) => {
      writeFileSync(file, `${JSON.stringify(line)}\n`)
      return outputAt({ file, offset: 0 }, id)
    }
    expect(read({ message: { content: [{ type: 'tool', id: 'a', state: { content: [{ type: 'text', text: 'Result' }] } }] } }, 'opencode-tool-a')).toBe('Result')
    expect(read({ message: { content: [{ type: 'tool', id: 'a', state: { error: { type: 'ToolError', data: { message: 'Failed' } } } }] } }, 'opencode-tool-a')).toBe('Failed')
    expect(read({ params: { update: { toolCallId: 'b', rawOutput: 'Raw' } } }, 'b')).toBe('Raw')
    expect(read({ params: { update: { toolCallId: 'b', content: [{ type: 'content', content: { type: 'text', text: 'Nested' } }] } } }, 'b')).toBe('Nested')
    expect(read({ params: { update: { toolCallId: 'b', rawOutput: 'Private other call' } } }, 'a')).toBeUndefined()
  })
})
