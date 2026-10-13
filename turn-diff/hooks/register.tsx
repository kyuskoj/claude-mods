import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { Turn, TurnFile } from '../types'

const PANE = 'turn-diff'
// Per-file cap so several expanded files fit in the 100k chars Code can draw at once
const MAX_HUNKS = 30000
// Every turn keeps its full diff, so drop old turns
const MAX_TURNS = 10
// The summary prompt gets the head of the final message, plus a short diff head per file when there is none
const SUMMARY_ANSWER = 500
const SUMMARY_HUNKS = 300
// The plan-mode plan file is no project change; wide-plan shows it
const PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/i

const history = atom({ plugin: 'turn-diff', key: 'history' } as const, [])
const expanded = atom({ plugin: 'turn-diff', key: 'expanded' } as const, [])
const openTurn = atom({ plugin: 'turn-diff', key: 'openTurn' } as const, null)

export const register: Register = on => {
  // Content just before the first touch this turn; null for a new file
  let before = new Map<string, string | null>()
  // The request that started this turn; keeps the summary in the user's language
  let request = ''

  on('session.start', async ($, e, next) => {
    // Summarize turns recorded before their summary arrived; first, so it runs even if registration fails
    for (const turn of await read($, history)) {
      if (turn.summary === undefined) {
        void summarize($, turn)
      }
    }

    await $.command.register({
      name: 'turn-diff',
      description: 'Show the files changed in recent turns',
    })

    return next(e)
  })

  on('command.run', { command: 'turn-diff' }, async $ => {
    await openPane($)

    return { text: 'Changes pane opened.' }
  })

  // The band asks the engine whether the pane is up; a close only asks it to look again
  on('ui.close', async ($, e, next) => {
    await next(e)

    if (e.id === PANE) {
      $.ui.invalidate('ui.render')
    }
  })

  on('turn.start', ($, e, next) => {
    before = new Map()
    request = e.text.trim().split('\n')[0]?.slice(0, 200) ?? ''

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
      const answer = e.answer.trim().slice(0, SUMMARY_ANSWER) || undefined
      const touched = before
      before = new Map()
      const changed = await diffAll($, touched)

      if (changed.length > 0) {
        const at = new Date(await $.clock.now()).toTimeString().slice(0, 5)
        const turns = await update($, history, list => {
          const no = (list[list.length - 1]?.no ?? 0) + 1

          return [...list, { id: e.turnId, no, at, request, answer, files: changed }].slice(-MAX_TURNS)
        })
        // The new turn opens, folding whichever was open
        await update($, openTurn, () => e.turnId)
        void openPane($)
        // Not awaited, so the summary never holds up the turn; the request shows until it arrives
        void summarize($, turns[turns.length - 1]!)
      }
    }

    return next(e)
  })

  // The row module (row.tsx) sends the pressed row's toggle key: a turn id or a `turnId:path` file key
  on('ui.message', async ($, e, next) => {
    const toggle = (e.data as { toggle?: unknown } | null)?.toggle

    if (e.requestId === PANE && typeof toggle === 'string') {
      const list = await read($, history)

      if (list.some(turn => turn.id === toggle)) {
        // One turn open at a time: pressing another switches to it, pressing the open one folds it
        const shown = shownTurn(list, await read($, openTurn))
        await update($, openTurn, () => (toggle === shown ? false : toggle))
      } else {
        await update($, expanded, keys => (keys.includes(toggle) ? keys.filter(one => one !== toggle) : [...keys, toggle]))
      }
    }

    return next(e)
  })

  // One press away from the pane while it is closed. Whatever the hooks beneath draw (wide-plan's button)
  // goes on the same row, so the band stays one line whichever plugin runs first
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const below = await next(e)
    const list = await read($, history)
    const latest = list[list.length - 1]
    // Whether the pane is up now, from the engine's own list
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

    if (latest === undefined || isOpen) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const totals = sum(latest.files)

    return (
      <Box gap={3}>
        <Box gap={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            Changes · {latest.summary || latest.request || '…'} · {latest.files.length} files
          </Text>
          <Box gap={1} flexShrink={0}>
            <Text>
              <Text color="diffAdded">+{totals.added}</Text> <Text color="diffRemoved">-{totals.removed}</Text>
            </Text>
            <Button key="open-changes" label="Open" onPress={() => openPane($)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Client, Code, Button } = $.ui.resolve(e)
    const list = await read($, history)
    const open = await read($, expanded)
    const shown = shownTurn(list, await read($, openTurn))

    if (list.length === 0) {
      return <Text dimColor>No changes recorded yet.</Text>
    }

    const fileRow = (turn: Turn, file: TurnFile, index: number) => {
      const key = `${turn.id}:${file.path}`
      const isOpen = open.includes(key)
      // The label alone goes in the row module, so the open button beside it is no part of the row's click area
      const row = { toggle: key, isOpen, label: file.label }

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Box gap={1}>
              <Client key={`f-${turn.no}-${index}`} module="./row.tsx" props={row} />
              <Button key={`open-${turn.no}-${index}`} label="↗" plain dimColor onPress={() => openDefault($, file.path)} />
            </Box>
            <Text>
              <Text color="diffAdded">+{file.added}</Text> <Text color="diffRemoved">-{file.removed}</Text>
            </Text>
          </Box>
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
          const isOpen = turn.id === shown
          const header = {
            toggle: turn.id,
            isOpen,
            label: turn.summary || turn.request || '…',
            note: turn.at,
            files: turn.files.length,
            ...sum(turn.files),
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

// The band hides its button once the pane is up
async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Changes', columns: 100 })
  $.ui.invalidate('ui.render')
}

function sum(files: readonly TurnFile[]): { added: number; removed: number } {
  return {
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  }
}

async function summarize($: EngineInterface, turn: Turn): Promise<void> {
  const files = turn.files.map(file => `${file.label} (+${file.added} -${file.removed})`).join('\n')
  // Without a final message, fall back to the head of each diff
  const context = turn.answer
    ? `Assistant's final message:\n${turn.answer}`
    : `Diff:\n${turn.files.map(file => file.hunks.slice(0, SUMMARY_HUNKS)).join('\n')}`
  const reply = await $.model.complete({
    model: 'haiku',
    system:
      'Summarize what this code change does as one short noun phrase, at most 30 characters, ' +
      'written in the same language as the user request. ' +
      'Describe the change in natural language. Never mention file names or paths. No period, no quotes.',
    prompt: `User request:\n${turn.request ?? ''}\n\n${context}\n\nFiles:\n${files}`,
    maxTokens: 60,
    effort: 'low',
    timeoutMs: 15000,
  })

  if (!reply.isAnswered) {
    return
  }

  const summary = reply.text.trim().split('\n')[0]?.slice(0, 60)

  if (summary) {
    await update($, history, list => list.map(one => (one.id === turn.id ? { ...one, summary } : one)))
  }
}

// The one open turn: none once the person folded it, the latest before they picked one
function shownTurn(list: readonly Turn[], chosen: string | false | null): string | undefined {
  if (chosen === false) {
    return undefined
  }

  return chosen ?? list[list.length - 1]?.id
}

// Opens the file with the program the OS associates with it; no plugin API does this, so ask the OS shell
async function openDefault($: EngineInterface, path: string): Promise<void> {
  if (!(await $.fs.exists(path))) {
    $.ui.toast(`turn-diff: ${path} no longer exists`)
    return
  }

  if ((await $.env.get('OS')) === 'Windows_NT') {
    // explorer exits 1 even when it opened the file, so its exit code says nothing
    await $.process.run(['explorer', path.replace(/\//g, '\\')])
    return
  }

  const uname = await $.process.run(['uname'])
  const run = await $.process.run([uname.stdout.trim() === 'Darwin' ? 'open' : 'xdg-open', path])

  if (run.exitCode !== 0) {
    $.ui.toast(`turn-diff: could not open ${path}`)
  }
}

function editedPath(e: ToolCallInput): string | undefined {
  if (e.tool === 'Edit' || e.tool === 'Write') {
    return PLAN_FILE.test(e.file_path) ? undefined : e.file_path
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
    // Exits 1 on a difference, 0 on none; anything else is a failure
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
