import { expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'

const DIFF = 'diff --git a/x b/y\r\n--- a/x\r\n+++ b/y\r\n@@ -1,2 +1,3 @@\r\n a\r\n-b\r\n+c\r\n+d\r\n'
const PANE = {
  title: 'Changes',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

function world(
  on: On,
  reads: string[],
  opened: string[],
  prompts: string[] = [],
  isAnswered = true,
  runs: string[][] = [],
  store = new Map<string, unknown>(),
): void {
  on('fs.read', ($, e) => {
    reads.push(e.path)

    return { value: 'a\nb\n' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])

    return { value: { exitCode: 1, stdout: DIFF, stderr: '' } } as never
  })
  on('env.get', ($, e) => ({ value: ({ OS: 'Windows_NT', TEMP: 'C:/temp', USERPROFILE: 'C:\\Users\\me' } as Record<string, string>)[e.name] }))
  on('session.cwd', () => ({ value: 'D:\\Beak' }))
  on('clock.now', () => ({ value: 0 }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('model.complete', ($, e) => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    prompts.push(e.prompt)

    return {
      value: isAnswered ? { isAnswered: true, text: 'Replace two lines\n', usage } : { isAnswered: false, reason: 'empty-reply', usage },
    } as never
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'ok' as never }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

async function editTurn($: Engine, turnId: string, path: string, answer = ''): Promise<void> {
  await $.turn.start({ text: 'rename the counter\nmore detail', turnId })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Edit', file_path: path, old_string: 'c', new_string: 'c\nd' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('snapshots once per file and records the turn with counts, leaving the pane closed', async ($, on) => {
  const reads: string[] = []
  const opened: string[] = []
  world(on, reads, opened)

  await editTurn($, 't1', 'D:\\Beak\\Assets\\a.cs')

  expect(reads).toEqual(['D:\\Beak\\Assets\\a.cs'])
  expect(opened).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'turn-diff', surface, component: 'Pane', requestId: 'turn-diff', props: PANE })
    expect(await ui.find({ type: 'Text', text: /1 files/, in: 't-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▾ Replace two lines/, in: 't-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ Assets\/a\.cs/, in: 'f-1-0' })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 'f-1-0' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 'f-1-0' })
    await ui.unmount()
  }
})

test('keeps one turn open at a time, the latest first', async ($, on) => {
  world(on, [], [])

  await editTurn($, 't1', 'D:\\Beak\\Old\\old.txt')
  await editTurn($, 't2', 'D:\\Beak\\new.cs')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'turn-diff', surface, component: 'Pane', requestId: 'turn-diff', props: PANE })
    expect(await ui.find({ type: 'Text', text: /new\.cs/, in: 'f-2-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ Replace two lines/, in: 't-1' })).toBeDefined()
    expect(await ui.find({ key: 'f-1-0' })).toBeUndefined()

    // Opening the older turn folds the latest
    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
    expect(await ui.find({ type: 'Text', text: /Old\/old\.txt/, in: 'f-1-0' })).toBeDefined()
    expect(await ui.find({ key: 'f-2-0' })).toBeUndefined()

    // Pressing the open turn folds it, leaving none open
    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
    expect(await ui.find({ key: 'f-1-0' })).toBeUndefined()
    expect(await ui.find({ key: 'f-2-0' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-2' })
    expect(await ui.find({ key: 'f-2-0' })).toBeDefined()
    expect(await ui.find({ key: 'f-1-0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('opens each new turn and folds the one picked before', async ($, on) => {
  world(on, [], [])

  await editTurn($, 't1', 'D:\\Beak\\a.cs')
  await editTurn($, 't2', 'D:\\Beak\\b.cs')

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
  expect(await ui.find({ key: 'f-1-0' })).toBeDefined()

  await editTurn($, 't3', 'D:\\Beak\\c.cs')
  expect(await ui.find({ key: 'f-3-0' })).toBeDefined()
  expect(await ui.find({ key: 'f-1-0' })).toBeUndefined()
  await ui.unmount()
})

test('opens a changed file with the default app from the button beside its name', async ($, on) => {
  const runs: string[][] = []
  world(on, [], [], [], true, runs)

  await editTurn($, 't1', 'D:/Beak/Assets/a.cs')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'turn-diff', surface, component: 'Pane', requestId: 'turn-diff', props: PANE })
    expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeDefined()
    // Two lines before, two added and one removed
    expect(await ui.find({ type: 'Text', text: /3 lines/ })).toBeDefined()

    runs.length = 0
    await ui.press({ key: 'open-1-0' })
    expect(runs).toEqual([['explorer', 'D:\\Beak\\Assets\\a.cs']])
    // The press opens the file without folding the row open
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.unmount()
  }
})

test('ignores a turn without edits', async ($, on) => {
  world(on, [], [])

  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /No changes recorded yet/ })).toBeDefined()
  await ui.unmount()
})

test('summarizes from the request and final message without the diff', async ($, on) => {
  const prompts: string[] = []
  world(on, [], [], prompts, false)

  await editTurn($, 't1', 'D:/Beak/a.cs', 'Renamed the counter.')

  expect(prompts[0]).toContain('User request:\nrename the counter\n')
  expect(prompts[0]).not.toContain('more detail')
  expect(prompts[0]).toContain("Assistant's final message:\nRenamed the counter.")
  expect(prompts[0]).toContain('a.cs (+2 -1)')
  expect(prompts[0]).not.toContain('@@')

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /▾ rename the counter/, in: 't-1' })).toBeDefined()
  await ui.unmount()
})

test('falls back to the diff head when the turn has no final message', async ($, on) => {
  const prompts: string[] = []
  world(on, [], [], prompts)

  await editTurn($, 't1', 'D:/Beak/a.cs')

  expect(prompts[0]).not.toContain("Assistant's final message")
  expect(prompts[0]).toContain('@@ -1,2 +1,3 @@')
})

test('leaves the plan-mode plan file out', async ($, on) => {
  const opened: string[] = []
  world(on, [], opened)

  await editTurn($, 't1', 'C:/Users/me/.claude/plans/bright-sketch.md')
  await editTurn($, 't2', 'C:\\Users\\me\\.claude\\plans\\bright-sketch.md')

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /No changes recorded yet/ })).toBeDefined()
  await ui.unmount()
})

test('leaves files outside the project and ~/.claude out, without reading them', async ($, on) => {
  const reads: string[] = []
  world(on, reads, [])

  await editTurn($, 't1', 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratchpad\\notes.md')
  await editTurn($, 't2', 'D:/Beakers/a.cs')
  await editTurn($, 't3', 'd:\\beak\\Assets\\a.cs')
  await editTurn($, 't4', 'C:\\Users\\me\\.claude\\CLAUDE.md')

  expect(reads).toEqual(['d:\\beak\\Assets\\a.cs', 'C:\\Users\\me\\.claude\\CLAUDE.md'])

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /~\/\.claude\/CLAUDE\.md/, in: 'f-2-0' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
  expect(await ui.find({ type: 'Text', text: /Assets\/a\.cs/, in: 'f-1-0' })).toBeDefined()
  expect(await ui.find({ key: 't-3' })).toBeUndefined()
  await ui.unmount()
})

test('shows an open button above the prompt only while the pane is closed', async ($, on) => {
  const opened: string[] = []
  // The pane counts as up after an open since the person last closed it
  let closedAt = 0
  world(on, [], opened)
  on('ui.panes', () => ({ value: opened.length > closedAt ? [{ id: 'turn-diff' }] : [] }) as never)
  // Stands for the engine's own band
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
  const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const mount = (surface: 'terminal' | 'desktop') =>
    $.ui.mount({ plugin: 'turn-diff', surface, component: 'AbovePrompt', requestId: 'band', props: band as never })

  const empty = await mount('desktop')
  expect(await empty.find({ key: 'open-changes' })).toBeUndefined()
  await empty.unmount()

  // The turn leaves the pane closed; the band offers it
  await editTurn($, 't1', 'D:/Beak/a.cs')
  expect(opened).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    closedAt = opened.length
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: /1 files/ })).toBeDefined()

    await ui.press({ key: 'open-changes' })
    expect(opened[opened.length - 1]).toBe('turn-diff')
    expect(await ui.find({ key: 'open-changes' })).toBeUndefined()
    await ui.unmount()
  }
})

test('keeps the session turns in the store, for the latest five sessions', async ($, on) => {
  const store = new Map<string, unknown>([1, 2, 3, 4, 5].map(no => [`history:old${no}`, []]))
  world(on, [], [], [], true, [], store)

  await editTurn($, 't1', 'D:/Beak/a.cs')
  // The first turn's summary lands unawaited; the second turn's save comes after it
  await editTurn($, 't2', 'D:/Beak/b.cs')

  expect([...store.keys()]).toEqual(['history:old2', 'history:old3', 'history:old4', 'history:old5', 'history:s1'])
  const saved = store.get('history:s1') as { summary?: string; files: { lines?: number }[] }[]
  expect(saved.length).toBe(2)
  expect(saved[0]?.summary).toBe('Replace two lines')
  expect(saved[0]?.files[0]?.lines).toBe(3)
})

test('brings the turns back from the store when the app starts the session again', async ($, on) => {
  const turn = {
    id: 't9',
    no: 4,
    at: '10:00',
    request: 'go',
    summary: 'Saved before the restart',
    files: [{ path: 'D:/Beak/a.cs', label: 'a.cs', added: 1, removed: 0, lines: 7, hunks: '@@ -1 +1,2 @@\n a\n+b\n' }],
  }
  world(on, [], [], [], true, [], new Map([['history:s1', [turn]]]))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))

  await $.session.start({ cwd: 'D:\\Beak', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /▾ Saved before the restart/, in: 't-4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /7 lines/ })).toBeDefined()
  await ui.unmount()

  // The pane starts closed after a restart, so the band offers it
  const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const above = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'AbovePrompt', requestId: 'band', props: band as never })
  expect(await above.find({ key: 'open-changes' })).toBeDefined()
  await above.unmount()
})

test('a turn after a restart adds to the stored turns even without session.start', async ($, on) => {
  const store = new Map<string, unknown>([['history:s1', [{ id: 't9', no: 4, at: '10:00', files: [] }]]])
  world(on, [], [], [], true, [], store)

  await editTurn($, 't1', 'D:/Beak/a.cs')

  expect((store.get('history:s1') as { no: number }[]).map(turn => turn.no)).toEqual([4, 5])
})

test('still records the turn when the store fails', async ($, on) => {
  const opened: string[] = []
  class FullStore extends Map<string, unknown> {
    override set(): never {
      throw new Error('disk full')
    }
  }
  world(on, [], [], [], true, [], new FullStore())

  await editTurn($, 't1', 'D:/Beak/a.cs')

  const ui = await $.ui.mount({ plugin: 'turn-diff', surface: 'desktop', component: 'Pane', requestId: 'turn-diff', props: PANE })
  expect(await ui.find({ type: 'Text', text: /a\.cs/, in: 'f-1-0' })).toBeDefined()
  await ui.unmount()
})
