import type { ScreenMenu } from './chats.ts'

/** OpenCode 2 may report ready while its startup integration dialog owns keyboard input. Never type a chat into it. */
export function openCodeMenu(screen: string): ScreenMenu | null {
  if (!/^\s*Connect an integration\s+esc\s*$/m.test(screen)) return null
  return { title: 'Connect an integration in OpenCode', choices: [], cursor: 0, screen: screen.trim() }
}
