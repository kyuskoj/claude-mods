/** 한 턴에서 바뀐 파일 하나의 요약과 diff. */
export type TurnFile = {
  /** 도구가 받은 절대 경로. */
  path: string
  /** 화면에 그리는 짧은 경로: 세션 폴더 기준 상대 경로, 밖이면 상위 폴더와 파일명. */
  label: string
  added: number
  removed: number
  /** `@@`부터 시작하는 unified diff 헝크. */
  hunks: string
}

/** 파일을 바꾼 턴 하나. */
export type Turn = {
  id: string
  /** 화면에 그리는 턴 번호. 오래된 턴을 버려도 바뀌지 않는다. */
  no: number
  /** 턴이 끝난 시각, `HH:MM`. */
  at: string
  /** 모델이 쓴 한 줄 요약. 오기 전이나 실패하면 없다. */
  summary?: string
  files: TurnFile[]
}

declare module 'claude-code' {
  interface PluginState {
    /** 오래된 턴이 맨 앞이다. `expanded`는 기본 상태에서 뒤집은 턴 id와 펼친 `턴id:경로` 키를 담는다. */
    'turn-diff': { history: Turn[]; expanded: string[] }
  }
}
