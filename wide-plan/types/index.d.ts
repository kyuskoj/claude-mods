/** The plan file shown in the panel. */
export type Plan = { path: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    /** `path` is the session plan file reported by the plan-mode notice. */
    'wide-plan': { shown: Plan | null; path: string | null }
  }
}
