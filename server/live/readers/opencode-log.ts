// OpenCode 2.1's authoritative transcript is SQLite's session_v2/session_message projection. Keep its DB
// read-only (including WAL visibility), and materialize just the selected session into a private JSONL cache for
// LogTail. New rows use the indexed (session_id, seq) cursor; only unfinished assistant rows need re-reading.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { HOME } from '../../store.ts'

// Bound both many tiny messages and a few large ones; stay below LogTail's 4 MiB chunk per synchronous read.
const ROWS = 256
const BYTES = 2 << 20
const MAX_MESSAGE = 1 << 20
// A cached row adds a small envelope to the bounded source JSON. Never scan an entire session to repair a tail.
const REPAIR_BYTES = MAX_MESSAGE + 4096
// Normally there is one current assistant. Retain a short interrupted/retry tail without polling every old row.
const ACTIVE = 16
const SESSION_ID = /^ses[A-Za-z0-9_-]{1,160}$/

interface SessionRow { id: string; directory: string; time_created: number }
interface MessageRow { id: string; type: string; seq: number; time_created: number; data: string | null }
interface Cursor { seq: number; active: Record<string, string>; bytes: number }

export interface OpenCodeLogOptions {
  database?: string
  cacheDir?: string
  /** Work per read stays bounded even for a session with years of history. */
  rows?: number
}

/** OpenCode's data path, as `opencode debug paths` reports it on Unix. */
export const opencodeHome = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class OpenCodeLogs {
  private database: string
  private cacheDir: string
  private rows: number
  private warnings = new Map<string, number>()

  constructor(options: OpenCodeLogOptions = {}) {
    this.database = options.database ?? join(opencodeHome(), 'opencode.db')
    this.cacheDir = resolve(options.cacheDir ?? join(HOME, 'opencode'))
    const rows = options.rows ?? ROWS
    this.rows = Number.isFinite(rows) ? Math.max(1, Math.min(ROWS, Math.floor(rows))) : ROWS
  }

  private warn(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const now = Date.now()
    if (now - (this.warnings.get(message) ?? 0) < 30_000) return
    this.warnings.set(message, now)
    if (this.warnings.size > 16) this.warnings.delete(this.warnings.keys().next().value!)
    console.warn(`OpenCode transcript unavailable: ${message}`)
  }

  private open(): Database | undefined {
    if (!existsSync(this.database)) return undefined
    const db = new Database(this.database, { readonly: true, strict: true })
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 20')
      for (const [table, required] of [
        ['session_v2', ['id', 'directory', 'parent_id', 'time_created', 'time_archived']],
        ['session_message', ['id', 'session_id', 'type', 'seq', 'time_created', 'data']],
      ] as const) {
        const columns = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
        if (!required.every((column) => columns.has(column))) throw new Error('unsupported OpenCode database schema (requires the version 2 session projection)')
      }
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  sessionId(file: string): string | undefined {
    if (resolve(dirname(file)) !== this.cacheDir) return undefined
    const id = basename(file).replace(/\.jsonl$/, '')
    return file.endsWith('.jsonl') && SESSION_ID.test(id) ? id : undefined
  }

  /** An interrupted append has no cursor commit. Drop only its incomplete final line before stable-id replay. */
  private repairTail(file: string): boolean {
    const fd = openSync(file, 'r+')
    try {
      const size = fstatSync(fd).size
      if (!size) return true
      const end = Buffer.allocUnsafe(1)
      if (readSync(fd, end, 0, 1, size - 1) !== 1) throw new Error('transcript cache changed during tail repair')
      if (end[0] === 10) return false
      const length = Math.min(size, REPAIR_BYTES)
      const tail = Buffer.allocUnsafe(length)
      if (readSync(fd, tail, 0, length, size - length) !== length) throw new Error('transcript cache changed during tail repair')
      const newline = tail.lastIndexOf(10)
      if (newline < 0 && size > REPAIR_BYTES) throw new Error('incomplete transcript cache line exceeds the bounded repair limit')
      ftruncateSync(fd, newline < 0 ? 0 : size - length + newline + 1)
      return true
    } finally {
      closeSync(fd)
    }
  }

  /** Explicit ids pin a session. Call without an id only when the caller intends cwd-based discovery. */
  find(cwd: string, sinceMs?: number, sessionId?: string): string | undefined {
    if (sessionId !== undefined && !SESSION_ID.test(sessionId)) return undefined
    let db: Database | undefined
    try {
      db = this.open()
      if (!db) return undefined
      const directory = cwd.replace(/\/+$/, '') || '/'
      const session = sessionId !== undefined
        ? db.query('SELECT id, directory, time_created FROM session_v2 WHERE id = ? AND directory = ? AND parent_id IS NULL').get(sessionId, directory) as SessionRow | null
        : db.query(`SELECT id, directory, time_created FROM session_v2
          WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL AND time_created >= ?
          ORDER BY time_created DESC, id DESC LIMIT 1`).get(directory, sinceMs ?? 0) as SessionRow | null
      if (!session || !SESSION_ID.test(session.id)) return undefined
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
      const file = join(this.cacheDir, `${session.id}.jsonl`)
      if (!existsSync(file)) writeFileSync(file, `${JSON.stringify({ type: 'session', id: session.id, at: session.time_created })}\n`, { mode: 0o600, flag: 'wx' })
      db.close()
      db = undefined
      this.refresh(file)
      return file
    } catch (error) {
      this.warn(error)
      return undefined
    } finally {
      db?.close()
    }
  }

  /** Returns true when this bounded page left more new rows for the next refresh. */
  refresh(file: string): boolean {
    const sessionId = this.sessionId(file)
    if (!sessionId || !existsSync(file)) return false
    let db: Database | undefined
    let transaction = false
    try {
      db = this.open()
      if (!db) return false
      // A completion and its following idle marker must come from one WAL snapshot. Otherwise a writer can
      // commit between the active-row lookup and the new-row query, showing idle before the completed reply.
      db.exec('BEGIN')
      transaction = true
      const repaired = this.repairTail(file)
      if (statSync(file).size === 0) {
        const session = db.query('SELECT time_created FROM session_v2 WHERE id = ?').get(sessionId) as { time_created: number } | null
        appendFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, at: session?.time_created ?? 0 })}\n`, { mode: 0o600 })
      }
      const cursorFile = `${file}.cursor.json`
      const cacheBytes = statSync(file).size
      let cursor: Cursor = { seq: -1, active: {}, bytes: cacheBytes }
      let fresh = true
      try {
        const saved = JSON.parse(readFileSync(cursorFile, 'utf8')) as Cursor
        // The file and cursor are separate commits. A crash may lose even a complete last line while keeping
        // the newer cursor; bind the cursor to the exact cache length, including for old-format sidecars.
        if (Number.isSafeInteger(saved.bytes) && saved.bytes === cacheBytes && Number.isSafeInteger(saved.seq) && saved.seq >= -1 && saved.active && typeof saved.active === 'object' && !Array.isArray(saved.active)) {
          cursor = { seq: saved.seq, active: Object.fromEntries(Object.entries(saved.active).filter(([id, value]) => typeof value === 'string' && /^msg_/.test(id)).slice(-ACTIVE)), bytes: saved.bytes }
          fresh = false
        }
      } catch { /* a new or interrupted cache rebuilds by stable message ids */ }
      // The interrupted record may update an older assistant, so replay from the projection rather than guessing
      // its seq from partial JSON. Both the scan and each subsequent replay page remain bounded.
      if (repaired) cursor = { seq: -1, active: {}, bytes: cacheBytes }
      let bytes = 0
      let changed = repaired || fresh
      const append = (row: MessageRow) => {
        const payload = row.data ?? JSON.stringify({ time: { created: row.time_created }, error: { message: 'OpenCode transcript item exceeds the 1 MiB cache limit' }, content: [] })
        const signature = hash(payload)
        if (cursor.active[row.id] === signature) return
        let data: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(payload)
          if (!value || typeof value !== 'object' || Array.isArray(value)) return
          data = value as Record<string, unknown>
        } catch { return }
        const message = { ...data, id: row.id, type: row.data === null ? 'assistant' : row.type }
        const line = `${JSON.stringify({ type: 'message', seq: row.seq, at: row.time_created, message })}\n`
        appendFileSync(file, line, { mode: 0o600 })
        bytes += Buffer.byteLength(line)
        changed = true
        const time = data.time && typeof data.time === 'object' ? data.time as Record<string, unknown> : {}
        if (row.type === 'assistant' && row.data !== null && typeof time.completed !== 'number') cursor.active[row.id] = signature
        else delete cursor.active[row.id]
        const ids = Object.keys(cursor.active)
        if (ids.length > ACTIVE) delete cursor.active[ids[0]]
      }
      const columns = `id, type, seq, time_created, CASE WHEN length(CAST(data AS BLOB)) <= ${MAX_MESSAGE} THEN data ELSE NULL END AS data`
      // Indexed primary-key lookups only: completed historical messages never need polling again.
      const active = db.query(`SELECT ${columns} FROM session_message WHERE id = ? AND session_id = ?`)
      for (const id of Object.keys(cursor.active)) {
        const row = active.get(id, sessionId) as MessageRow | null
        if (row) append(row)
        else { delete cursor.active[id]; changed = true }
        if (bytes >= BYTES) break
      }
      let read = 0
      if (bytes < BYTES) {
        const rows = db.query(`SELECT ${columns} FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
        for (const row of rows.iterate(sessionId, cursor.seq, this.rows) as Iterable<MessageRow>) {
          append(row)
          cursor.seq = row.seq
          changed = true
          read++
          if (bytes >= BYTES) break
        }
      }
      db.exec('COMMIT')
      transaction = false
      if (changed) {
        cursor.bytes = statSync(file).size
        const tmp = `${cursorFile}.tmp`
        writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 })
        renameSync(tmp, cursorFile)
      }
      return read >= this.rows || bytes >= BYTES
    } catch (error) {
      this.warn(error)
      return false
    } finally {
      if (transaction) {
        try { db?.exec('ROLLBACK') } catch { /* close also releases an interrupted read transaction */ }
      }
      db?.close()
    }
  }
}

const logs = new OpenCodeLogs()
// A remote worker's filesystem is mirrored; its transcript must never come from the main machine's native DB.
export const findOpenCodeLog = (cwd: string, sinceMs?: number, sessionId?: string) => process.env.SHEPHERDR_BOX ? undefined : logs.find(cwd, sinceMs, sessionId)
export const refreshOpenCodeLog = (file: string) => process.env.SHEPHERDR_BOX ? false : logs.refresh(file)
export const openCodeSessionId = (file: string) => logs.sessionId(file)
