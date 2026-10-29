// Grok Build's durable ACP stream lives beside summary.json, under a URL-encoded cwd and session UUID.
// xai-grok-config paths.rs uses RFC 3986 encoding; long cwd names instead carry their exact path in .cwd.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const encodedCwd = (cwd: string) => encodeURIComponent(cwd).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export const grokHome = () => process.env.GROK_HOME || join(homedir(), '.grok')

/** Grok's cwd-level session folder. Resolve hashed names through their metadata without another hash dependency. */
export function grokSessionDir(cwd: string): string {
  const root = join(grokHome(), 'sessions')
  const name = encodedCwd(cwd)
  if (name.length <= 255) return join(root, name)
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/-[0-9a-f]{16}$/.test(entry.name)) continue
      const metadata = join(root, entry.name, '.cwd')
      try {
        if (statSync(metadata).size <= (64 << 10) && readFileSync(metadata, 'utf8').trim() === cwd) return join(root, entry.name)
      } catch {
        // A different cwd's directory may be incomplete or unreadable.
      }
    }
  } catch {
    // The session folder may not exist yet; discovery is retried after the CLI starts.
  }
  return join(root, name)
}

export const grokLogPath = (cwd: string, sessionId: string) => join(grokSessionDir(cwd), sessionId, 'updates.jsonl')

/** Only Grok's UUID session directories identify sessions; arbitrary nested logs are not resumable sessions. */
export function grokSessionId(file: string): string | undefined {
  const id = basename(dirname(file))
  return basename(file) === 'updates.jsonl' && UUID.test(id) ? id : undefined
}

/** The newest main session for this cwd. Read summaries only, never recursively scan other projects or subagents. */
export function findGrokLog(cwd: string, sinceMs = 0): string | undefined {
  const dir = grokSessionDir(cwd)
  let best: { file: string; modified: number } | undefined
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      const folder = join(dir, entry.name)
      const file = join(folder, 'updates.jsonl')
      try {
        const summaryFile = join(folder, 'summary.json')
        if (!existsSync(summaryFile) || statSync(summaryFile).size > (1 << 20)) continue
        const summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
        if (summary?.info?.cwd !== cwd || summary.info.id !== entry.name || String(summary.session_kind ?? '').startsWith('subagent')) continue
        const stat = statSync(file)
        if (stat.isFile() && stat.mtimeMs >= sinceMs && (!best || stat.mtimeMs > best.modified)) best = { file, modified: stat.mtimeMs }
      } catch {
        // Grok creates and rotates the files while discovery runs.
      }
    }
  } catch {
    // No sessions for this cwd yet.
  }
  return best?.file
}
