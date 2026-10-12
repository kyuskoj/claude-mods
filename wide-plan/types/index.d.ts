/** 패널에 띄운 플랜 파일. */
export type Plan = { path: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    /** `path`는 계획 모드 알림이 알려 준 이 세션의 플랜 파일 경로다. */
    'wide-plan': { shown: Plan | null; path: string | null }
  }
}
