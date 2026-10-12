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

function world(on: On, reads: string[], opened: string[], prompts: string[] = [], isAnswered = true): void {
  on('fs.read', ($, e) => {
    reads.push(e.path)

    return { value: 'a\nb\n' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: DIFF, stderr: '' } }) as never)
  on('env.get', () => ({ value: 'C:/temp' }))
  on('session.cwd', () => ({ value: 'D:\\Beak' }))
  on('clock.now', () => ({ value: 0 }))
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

test('snapshots once per file and opens the pane with counts', async ($, on) => {
  const reads: string[] = []
  const opened: string[] = []
  world(on, reads, opened)

  await editTurn($, 't1', 'D:\\Beak\\Assets\\a.cs')

  expect(reads).toEqual(['D:\\Beak\\Assets\\a.cs'])
  expect(opened).toEqual(['turn-diff'])

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

test('keeps the previous turn folded above the latest', async ($, on) => {
  world(on, [], [])

  await editTurn($, 't1', 'C:\\Temp\\scratch\\old.txt')
  await editTurn($, 't2', 'D:\\Beak\\new.cs')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'turn-diff', surface, component: 'Pane', requestId: 'turn-diff', props: PANE })
    expect(await ui.find({ type: 'Text', text: /new\.cs/, in: 'f-2-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ Replace two lines/, in: 't-1' })).toBeDefined()
    expect(await ui.find({ key: 'f-1-0' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
    expect(await ui.find({ type: 'Text', text: /…\/scratch\/old\.txt/, in: 'f-1-0' })).toBeDefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-2' })
    expect(await ui.find({ key: 'f-2-0' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-1' })
    await ui.pointer({ type: 'down', x: 30, y: 0, button: 'left', in: 't-2' })
    await ui.unmount()
  }
})

test('ignores a turn without edits', async ($, on) => {
  const opened: string[] = []
  world(on, [], opened)

  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })

  expect(opened).toEqual([])
})

test('summarizes from the request and final message without the diff', async ($, on) => {
  const prompts: string[] = []
  world(on, [], [], prompts, false)

  await editTurn($, 't1', 'D:\Beak\a.cs', 'Renamed the counter.')

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

  await editTurn($, 't1', 'D:\Beak\a.cs')

  expect(prompts[0]).not.toContain("Assistant's final message")
  expect(prompts[0]).toContain('@@ -1,2 +1,3 @@')
})
