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

function world(on: On, opened: string[], reads: string[], isDenied = false, exists = (path: string) => path !== ''): void {
  on('fs.read', ($, e) => {
    reads.push(e.path)

    return { value: '# Title\r\n\r\nBody\r\n' }
  })
  on('fs.exists', ($, e) => ({ value: exists(e.path) }))
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
  expect(opened).toEqual([])
  expect(reads[reads.length - 1]).toBe(PLAN_PATH.toLowerCase())

  await $.tool.call({ tool: 'ExitPlanMode' })
  expect(opened).toEqual([])
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

  expect(opened).toEqual([])
})

test('puts the open button on the ExitPlanMode row only', async ($, on) => {
  world(on, [], [])
  // Stands for the engine's own row
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine row' }))
  await enterPlanMode($)

  const row = (tool: string) => ({
    tool_use_id: 'toolu_1',
    tool,
    input: {},
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const plan = await $.ui.mount({ plugin: 'wide-plan', surface, component: 'ToolUse', requestId: 'toolu_1', props: row('ExitPlanMode') })
    expect(await plan.find({ type: 'Button' })).toBeDefined()
    await plan.unmount()

    const other = await $.ui.mount({ plugin: 'wide-plan', surface, component: 'ToolUse', requestId: 'toolu_1', props: row('Write') })
    expect(await other.find({ type: 'Button' })).toBeUndefined()
    await other.unmount()
  }
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

test("ignores a subagent's plan-mode notice and calls", async ($, on) => {
  const opened: string[] = []
  const reads: string[] = []
  world(on, opened, reads)
  on('session.messages', () => ({ value: [] }) as never)

  await enterPlanMode($)
  // A Plan subagent is told about a file of its own
  await $.prompt.attachment({
    type: 'plan_mode',
    text: 'Plan mode is active.',
    origin: { kind: 'engine' },
    agentId: 'a9611c6943fcdbe4b',
    detail: { reminder: 'full', planFilePath: OTHER_PLAN, hasPlan: false },
  })
  await $.tool.call({ tool: 'ExitPlanMode', agentId: 'a9611c6943fcdbe4b' } as never)
  expect(reads).toEqual([])

  const ran = await $.command.run({ command: 'wide-plan', args: '' } as never)

  expect((ran as { text?: string }).text).toBe('Plan pane opened.')
  expect(reads).toEqual([PLAN_PATH])
})

test('shows an open button above the prompt beside what is drawn beneath, while the pane is closed', async ($, on) => {
  const opened: string[] = []
  world(on, opened, [])
  on('ui.panes', () => ({ value: opened.length > 0 ? [{ id: 'plan' }] : [] }) as never)
  // Stands for turn-diff's button, drawn beneath
  on('ui.render', ($, e) => {
    const { Box, Button } = $.ui.resolve(e)

    return Box({ children: [Button({ key: 'open-changes', label: 'Open', onPress: () => undefined })] })
  })
  const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }
  const mount = (surface: 'terminal' | 'desktop') =>
    $.ui.mount({ plugin: 'wide-plan', surface, component: 'AbovePrompt', requestId: 'band', props: band as never })

  // No plan: only what is beneath
  const empty = await mount('desktop')
  expect(await empty.find({ key: 'open-plan' })).toBeUndefined()
  expect(await empty.find({ key: 'open-changes' })).toBeDefined()
  await empty.unmount()

  await enterPlanMode($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: /Plan · real-plan\.md/ })).toBeDefined()
    expect(await ui.find({ key: 'open-changes' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await mount('desktop')
  await ui.press({ key: 'open-plan' })
  expect(opened).toEqual(['plan'])
  expect(await ui.find({ key: 'open-plan' })).toBeUndefined()
  expect(await ui.find({ key: 'open-changes' })).toBeDefined()
  await ui.unmount()
})

test('falls back to the transcript when the remembered file is missing', async ($, on) => {
  const opened: string[] = []
  world(on, opened, [], false, path => path === OTHER_PLAN)
  on('session.messages', () => ({
    value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Write', input: { file_path: OTHER_PLAN } }] }],
  }) as never)

  await enterPlanMode($)
  const ran = await $.command.run({ command: 'wide-plan', args: '' } as never)

  expect((ran as { text?: string }).text).toBe('Plan pane opened.')
})

test('finds the written plan when the notice was missed and ExitPlanMode was rejected', async ($, on) => {
  const opened: string[] = []
  world(on, opened, [])
  on('session.messages', () => ({
    value: [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Write', input: { file_path: 'D:\\Beak\\notes.md' } }] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool_use_id: 'b', tool: 'Write', input: { file_path: PLAN_PATH }, text: `File created successfully at: ${PLAN_PATH}` },
          { tool_use_id: 'c', tool: 'Edit', input: { file_path: OTHER_PLAN }, isError: true, text: 'failed' },
        ],
      },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'd', tool: 'ExitPlanMode', input: {}, isError: true, text: "The user doesn't want to proceed with this tool use." }],
      },
    ],
  }) as never)

  const ran = await $.command.run({ command: 'wide-plan', args: '' } as never)

  expect((ran as { text?: string }).text).toBe('Plan pane opened.')
  expect(opened).toEqual(['plan'])
})
