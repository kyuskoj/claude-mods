import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PromptAttachmentInput,
  PromptAttachmentResult,
  Register,
  SessionMessage,
  ToolUseSummary,
} from 'claude-code'

const PANE = 'plan'
// Rows without a detail (host-specific plan notices) fall back to the path in the body
const PLAN_PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\/)[^\s`'"]*?\.claude[\\/]plans[\\/][^\s`'"\\/]+\.md/

const plan = atom({ plugin: 'wide-plan', key: 'shown' } as const, null)
const planPath = atom({ plugin: 'wide-plan', key: 'path' } as const, null)

export const register: Register = on => {
  on('prompt.attachment', { type: 'plan_mode' }, remember)
  on('prompt.attachment', { type: 'plan_mode_reentry' }, remember)
  on('prompt.attachment', { type: 'plan_mode_exit' }, remember)

  on('session.start', async ($, e, next) => {
    // A mod loaded after plan mode misses the notice, so recover the path from the transcript.
    // Do this before the registration below: if that fails the whole hook is skipped.
    // Most sessions have no plan, so finding none stays silent
    if ((await read($, planPath)) === null) {
      const path = lastExitedPlan(await $.session.messages())

      if (path !== undefined && (await $.fs.exists(path))) {
        await update($, planPath, () => path)
        await load($, path)
      }
    }

    await $.command.register({
      name: 'wide-plan',
      description: 'Show the current plan in a wide pane',
    })

    return next(e)
  })

  on('command.run', { command: 'wide-plan' }, async $ => {
    const path = await shownPlan($)

    if (path === undefined) {
      return { text: 'No plan has been written in plan mode in this session.' }
    }

    await show($, path)

    return { text: 'Plan pane opened.' }
  })

  // The band asks the engine whether the pane is up; a close only asks it to look again
  on('ui.close', async ($, e, next) => {
    await next(e)

    if (e.id === PANE) {
      $.ui.invalidate('ui.render')
    }
  })

  // The pane never opens by itself (the built-in plan view already shows the plan); the buttons and /wide-plan open it
  on('tool.call', async ($, e, next) => {
    // A subagent's plan-mode calls work on its own plan file, not the session's
    if (e.agentId !== undefined) {
      return next(e)
    }

    const path = await read($, planPath)

    // Right before approval, re-read the file so edits made elsewhere show up
    if (e.tool === 'ExitPlanMode') {
      if (path !== null && (await $.fs.exists(path))) {
        await load($, path)
      }

      const exited = await next(e)
      const filePath = (exited.result as { filePath?: unknown } | undefined)?.filePath

      // No path from the notice: remember the plan file named by the tool result
      if (path === null && typeof filePath === 'string') {
        await update($, planPath, () => filePath)
        await load($, filePath)
      }

      return exited
    }

    const ran = await next(e)
    const isPlanWrite = (e.tool === 'Write' || e.tool === 'Edit') && path !== null && isSamePath(e.file_path, path)

    if (isPlanWrite && ran.deny === undefined && ran.isError !== true) {
      await load($, e.file_path)
    }

    return ran
  })

  // The button sits on the plan's own row in the transcript, where it covers nothing
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const path = e.props.tool === 'ExitPlanMode' ? await shownPlan($) : undefined

    if (path === undefined) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Plan · {fileName(path)}</Text>
        <Button key="open" label="Wide plan" onPress={() => show($, path)} />
      </Box>
    )
  })

  // One press away from the pane while it is closed. Whatever the hooks beneath draw (turn-diff's button)
  // goes on the same row, so the band stays one line whichever plugin runs first
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const below = await next(e)
    // Read so a newly written plan redraws the band
    await read($, plan)
    // Whether the pane is up now, from the engine's own list
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    const path = isOpen ? undefined : await shownPlan($)

    if (path === undefined) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box gap={3}>
        <Box gap={1} flexShrink={0}>
          <Text dimColor>Plan · {fileName(path)}</Text>
          <Button key="open-plan" label="Open" onPress={() => show($, path)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Markdown, Text } = $.ui.resolve(e)
    const last = await read($, plan)
    // With empty state, look it up while drawing (read-only; state cannot be written during a draw)
    const path = last === null ? await shownPlan($) : undefined
    const text = last?.text ?? (path !== undefined ? (await $.fs.read(path)).replace(/\r/g, '') : null)

    if (text === null) {
      return <Text dimColor>No plan yet.</Text>
    }

    return <Markdown text={text} />
  })
}

// The plan-mode notice of the main loop reports this session's plan file path.
// A subagent in plan mode gets the same notice naming a file of its own, so its rows are skipped
async function remember(
  $: EngineInterface,
  e: PromptAttachmentInput,
  next: (e: PromptAttachmentInput) => Promise<PromptAttachmentResult>,
): Promise<PromptAttachmentResult> {
  const detail = e.detail as { planFilePath?: string } | undefined
  const path = detail?.planFilePath ?? e.text.match(PLAN_PATH_IN_TEXT)?.[0]

  if (e.agentId === undefined && path !== undefined) {
    await update($, planPath, () => path)
  }

  return next(e)
}

// The plan file a button would open, if one exists. The notice names the file before it is written,
// so until then the transcript's last plan counts
async function shownPlan($: EngineInterface): Promise<string | undefined> {
  const remembered = await read($, planPath)

  if (remembered !== null && (await $.fs.exists(remembered))) {
    return remembered
  }

  const path = lastExitedPlan(await $.session.messages())

  return path !== undefined && (await $.fs.exists(path)) ? path : undefined
}

function fileName(path: string): string | undefined {
  return path.replace(/\\/g, '/').split('/').pop()
}

function isSamePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replace(/\\/g, '/').toLowerCase()

  return normal(a) === normal(b)
}

// The plan-mode notice can be missed (desktop sends it with the first prompt) and a rejected
// ExitPlanMode names no file, so the plan file's own writes count too. The main transcript holds
// only the main loop's calls, so a subagent's plan never shows up here
function lastExitedPlan(messages: readonly SessionMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    for (const use of [...message.toolUses].reverse()) {
      const path = use.tool === 'ExitPlanMode' ? exitedPlan(use) : writtenPlan(use)

      if (path !== undefined) {
        return path
      }
    }
  }

  return undefined
}

function exitedPlan(use: ToolUseSummary): string | undefined {
  // Headless hosts such as desktop store trimmed tool records, so also search the result text
  const filePath = (use.result as { filePath?: unknown } | undefined)?.filePath

  return typeof filePath === 'string' ? filePath : use.text?.match(PLAN_PATH_IN_TEXT)?.[0]
}

function writtenPlan(use: ToolUseSummary): string | undefined {
  const filePath = use.input.file_path

  if ((use.tool !== 'Write' && use.tool !== 'Edit') || use.isError === true || typeof filePath !== 'string') {
    return undefined
  }

  return PLAN_PATH_IN_TEXT.exec(filePath)?.[0] === filePath ? filePath : undefined
}

async function load($: EngineInterface, path: string): Promise<void> {
  const text = (await $.fs.read(path)).replace(/\r/g, '')
  await update($, plan, () => ({ path, text }))
}

// The band hides its button once the pane is up
async function show($: EngineInterface, path: string): Promise<void> {
  await load($, path)
  await $.ui.open({ id: PANE, title: 'Plan', columns: 140 })
  $.ui.invalidate('ui.render')
}
