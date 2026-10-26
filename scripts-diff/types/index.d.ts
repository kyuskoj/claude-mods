/** One touched text file in the repository, as git sees it against HEAD. */
export type ChangedFile = {
  /** Path relative to the repository root. Its extension sets the group the pane shows it under. */
  path: string
  added: number
  removed: number
  /** Line count of the file now. Absent once the file is gone. */
  lines?: number
  /** Unified diff hunks against HEAD, starting at `@@`; empty when the file matches HEAD. */
  hunks: string
  /** `added`: new to git (untracked or staged new); `clean`: matches HEAD again (committed or reverted). */
  status: 'modified' | 'added' | 'deleted' | 'clean'
}

declare module 'claude-code' {
  interface PluginState {
    /**
     * `touched` holds repo-relative paths the agent changed this session, most recent first.
     * `files` is their latest diff in the same order, binary files left out. `expanded` holds the paths whose diff is open.
     * `latest` holds the paths changed in the latest main turn that changed any (`turnId` that turn's id, '' before one);
     * `onlyLatest` shows only those.
     * `notes` holds the change-intent explanations asked from the pane, by file path or `type:<extension>`;
     * `text` is the answer once `done`, the reason once `failed`.
     */
    'scripts-diff': {
      touched: string[]
      files: ChangedFile[]
      expanded: string[]
      latest: { turnId: string; paths: string[] }
      onlyLatest: boolean
      notes: Record<string, { state: 'running' | 'done' | 'failed'; text: string }>
    }
  }
}
