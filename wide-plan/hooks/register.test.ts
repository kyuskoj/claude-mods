import { expect, test } from 'claude-code/testing'
import type { Engine, On } from 'claude-code'

const PLAN_PATH = 'C:\\Users\\me\\.claude\\plans\\real-plan.md'
const OTHER_PLAN = 'C:\\Users\\me\\.claude\\plans\\other.md'
const PANE = {
  title: 'Plan',
  isFocused: false,
  bodyColumns: 140,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

function world(on: On, opened: string[], reads: string[], isDenied = false): void {
  on('fs.read', ($, e) => {
    reads.push(e.path)

    return { value: '# Title\r\n\r\nBody\r\n' }
  })
  on('fs.exists', () => ({ value: true }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('tool.call', () => (isDenied ? { deny: 'failed' } : { result: 'ok' as never }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
}

async function enterPlanMode($: Engine): Promise<void> {
  await $.prompt.attachment({
    type: 'plan_mode',
    text: 'Plan mode is active.',
    origin: { kind: 'engine' },
    detail: { reminder: 'full', planFilePath: PLAN_PATH, hasPlan: false },
  })
}

test('follows the plan file named by plan mode only', async ($, on) => {
  const opened: string[] = []
  const reads: string[] = []
  world(on, opened, reads)

  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: 'x' })
  expect(opened).toEqual([])

  await enterPlanMode($)

  await $.tool.call({ tool: 'Write', file_path: OTHER_PLAN, content: 'x' })
  expect(opened).toEqual([])

  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH.toLowerCase(), content: '# Title' })
  expect(opened).toEqual(['plan'])

  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(opened).toEqual(['plan', 'plan'])
  expect(reads[reads.length - 1]).toBe(PLAN_PATH)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'wide-plan', surface, component: 'Pane', requestId: 'plan', props: PANE })
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.unmount()
  }
})

test('reads the path from the text when the row has no detail', async ($, on) => {
  const opened: string[] = []
  world(on, opened, [])

  await $.prompt.attachment({
    type: 'plan_mode',
    text: `No plan file exists yet. You should create your plan at ${PLAN_PATH} using the Write tool.`,
    origin: { kind: 'engine' },
  })
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: 'x' })

  expect(opened).toEqual(['plan'])
})

test('stays closed when the write fails', async ($, on) => {
  const opened: string[] = []
  world(on, opened, [], true)

  await enterPlanMode($)
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: 'x' })

  expect(opened).toEqual([])
})

test('recovers the plan from the result text of the last ExitPlanMode', async ($, on) => {
  const opened: string[] = []
  const reads: string[] = []
  world(on, opened, reads)
  on('session.messages', () => ({
    value: [
      { role: 'assistant', text: '', toolUses: [{ tool: 'ExitPlanMode', input: {}, result: { filePath: OTHER_PLAN } }] },
      { role: 'assistant', text: '', toolUses: [{ tool: 'ExitPlanMode', input: {}, text: `Your plan has been saved to: ${PLAN_PATH}` }] },
    ],
  }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: 'D:\Beak' }) as never)

  await $.session.start({ cwd: 'D:\Beak', surface: 'desktop', isInteractive: true } as never)

  expect(reads).toEqual([PLAN_PATH])
  expect(opened).toEqual([])

  const ui = await $.ui.mount({ plugin: 'wide-plan', surface: 'desktop', component: 'Pane', requestId: 'plan', props: PANE })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()
})
