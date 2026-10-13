/** One file changed in a turn, with its diff. */
export type TurnFile = {
  /** Absolute path as the tool received it. */
  path: string
  /** Short path shown on screen: relative to the session folder, else parent folder and file name. */
  label: string
  added: number
  removed: number
  /** Line count of the file right after the turn. Absent on turns recorded before it was kept. */
  lines?: number
  /** Unified diff hunks, starting at `@@`. */
  hunks: string
}

/** One turn that changed files. */
export type Turn = {
  id: string
  /** Turn number shown on screen; stable when old turns are dropped. */
  no: number
  /** Time the turn ended, `HH:MM`. */
  at: string
  /** First line of the user request that started the turn. Sets the summary language and is the title until a summary exists. */
  request?: string
  /** Head of the assistant's final message; the main input to the summary. Absent when the turn ended without text. */
  answer?: string
  /** One-line model summary. Absent until it arrives or if it fails. */
  summary?: string
  files: TurnFile[]
}

declare module 'claude-code' {
  interface PluginState {
    /**
     * Oldest turn first. `expanded` holds opened `turnId:path` file keys.
     * `openTurn` is the one unfolded turn: its id, `false` once the person folded it, `null` (the latest) before any pick.
     */
    'turn-diff': { history: Turn[]; expanded: string[]; openTurn: string | false | null }
  }
}
