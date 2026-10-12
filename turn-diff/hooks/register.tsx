import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { Turn, TurnFile } from '../types'

const PANE = 'turn-diff'
// Code 한 번에 그릴 수 있는 10만 자 안에 여러 파일이 펼쳐져도 들어가도록 파일당 상한을 둔다
const MAX_HUNKS = 30000
// 턴마다 diff 전문을 들고 있으므로 오래된 턴은 버린다
const MAX_TURNS = 10
const SUMMARY_INPUT = 6000

const history = atom({ plugin: 'turn-diff', key: 'history' } as const, [])
const expanded = atom({ plugin: 'turn-diff', key: 'expanded' } as const, [])

export const register: Register = on => {
  // 이번 턴에 처음 건드리기 직전의 내용. null이면 새로 만든 파일이다
  let before = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    // 요약이 붙기 전에 기록된 턴은 로드될 때 마저 요약한다. 등록이 실패해도 돌도록 먼저 한다
    for (const turn of await read($, history)) {
      if (turn.summary === undefined) {
        void summarize($, turn.id, turn.files)
      }
    }

    await $.command.register({
      name: 'turn-diff',
      description: 'Show the files changed in recent turns',
    })

    return next(e)
  })

  on('command.run', { command: 'turn-diff' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Changes', columns: 100 })

    return { text: 'Changes pane opened.' }
  })

  on('turn.start', ($, e, next) => {
    before = new Map()

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const path = editedPath(e)

    if (path !== undefined && !before.has(path)) {
      before.set(path, await $.fs.read(path).catch(() => null))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && before.size > 0) {
      const touched = before
      before = new Map()
      const changed = await diffAll($, touched)

      if (changed.length > 0) {
        const at = new Date(await $.clock.now()).toTimeString().slice(0, 5)
        await update($, history, list => {
          const no = (list[list.length - 1]?.no ?? 0) + 1

          return [...list, { id: e.turnId, no, at, files: changed }].slice(-MAX_TURNS)
        })
        void $.ui.open({ id: PANE, title: 'Changes', columns: 100 })
        // 요약은 턴 종료를 붙잡지 않도록 기다리지 않는다. 오기 전에는 파일 이름이 대신 보인다
        void summarize($, e.turnId, changed)
      }
    }

    return next(e)
  })

  // 행 모듈(row.tsx)이 눌린 행의 toggle 키를 보낸다
  on('ui.message', async ($, e, next) => {
    const toggle = (e.data as { toggle?: unknown } | null)?.toggle

    if (e.requestId === PANE && typeof toggle === 'string') {
      await update($, expanded, keys => (keys.includes(toggle) ? keys.filter(one => one !== toggle) : [...keys, toggle]))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Client, Code } = $.ui.resolve(e)
    const list = await read($, history)
    const open = await read($, expanded)

    if (list.length === 0) {
      return <Text dimColor>No changes recorded yet.</Text>
    }

    const fileRow = (turn: Turn, file: TurnFile, index: number) => {
      const key = `${turn.id}:${file.path}`
      const isOpen = open.includes(key)
      const row = { toggle: key, isOpen, label: file.label, added: file.added, removed: file.removed }

      return (
        <Box flexDirection="column">
          <Client key={`f-${turn.no}-${index}`} module="./row.tsx" props={row} width="100%" />
          {isOpen && (
            <Box marginLeft={2}>
              <Code source={file.hunks} format="diff" path={file.path} wrap="truncate-end" />
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {list.map((turn, index) => {
          const isLatest = index === list.length - 1
          // 최신 턴은 펼친 상태가, 이전 턴은 접힌 상태가 기본이다. expanded에 있으면 기본을 뒤집는다
          const isOpen = isLatest !== open.includes(turn.id)
          const header = {
            toggle: turn.id,
            isOpen,
            label: turn.summary ?? `파일 ${turn.files.length}개 변경`,
            note: turn.at,
            files: turn.files.length,
            added: turn.files.reduce((sum, file) => sum + file.added, 0),
            removed: turn.files.reduce((sum, file) => sum + file.removed, 0),
            isBold: true,
          }

          return (
            <Box flexDirection="column" borderStyle="round" borderColor={isLatest ? 'claude' : 'subtle'} paddingX={1}>
              <Client key={`t-${turn.no}`} module="./row.tsx" props={header} width="100%" />
              {isOpen && (
                <Box flexDirection="column" gap={1} marginTop={1}>
                  {turn.files.map((file, fileIndex) => fileRow(turn, file, fileIndex))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

async function summarize($: EngineInterface, turnId: string, changed: TurnFile[]): Promise<void> {
  // 큰 diff도 요약 한 줄이면 충분하므로 앞부분만 보낸다
  const diff = changed
    .map(file => `${file.label} (+${file.added} -${file.removed})\n${file.hunks}`)
    .join('\n')
    .slice(0, SUMMARY_INPUT)
  const reply = await $.model.complete({
    model: 'haiku',
    system:
      'Summarize what this code change does as one short Korean noun phrase, at most 30 characters. ' +
      'Describe the change in natural language. Never mention file names or paths. No period, no quotes.',
    prompt: diff,
    maxTokens: 60,
    effort: 'low',
    timeoutMs: 15000,
  })

  if (!reply.isAnswered) {
    return
  }

  const summary = reply.text.trim().split('\n')[0]?.slice(0, 60)

  if (summary) {
    await update($, history, list => list.map(turn => (turn.id === turnId ? { ...turn, summary } : turn)))
  }
}

function editedPath(e: ToolCallInput): string | undefined {
  if (e.tool === 'Edit' || e.tool === 'Write') {
    return e.file_path
  }

  if (e.tool === 'NotebookEdit') {
    return e.notebook_path
  }

  return undefined
}

function shortPath(path: string, cwd: string): string {
  const normal = path.replace(/\\/g, '/')

  if (normal.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
    return normal.slice(cwd.length + 1)
  }

  return `…/${normal.split('/').slice(-2).join('/')}`
}

async function diffAll($: EngineInterface, touched: Map<string, string | null>): Promise<TurnFile[]> {
  const cwd = (await $.session.cwd()).replace(/\\/g, '/')
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  const beforePath = `${temp}/claude-turn-diff/before`
  const changed: TurnFile[] = []

  for (const [path, text] of touched) {
    await $.fs.write(beforePath, text ?? '')
    // 차이가 있으면 1, 없으면 0으로 끝난다. 그 밖은 실패다
    const run = await $.process.run(['git', 'diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', beforePath, path])

    if (run.exitCode !== 1) {
      continue
    }

    const hunks = run.stdout.replace(/\r/g, '').replace(/^[\s\S]*?(?=^@@)/m, '')
    const lines = hunks.split('\n')

    changed.push({
      path,
      label: shortPath(path, cwd),
      added: lines.filter(line => line.startsWith('+')).length,
      removed: lines.filter(line => line.startsWith('-')).length,
      hunks: hunks.length > MAX_HUNKS ? hunks.slice(0, Math.max(hunks.lastIndexOf('\n@@', MAX_HUNKS), 0)) : hunks,
    })
  }

  return changed
}
