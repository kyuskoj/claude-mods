import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptAttachmentInput, PromptAttachmentResult, Register, SessionMessage } from 'claude-code'

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
    // A mod loaded after plan mode misses the notice, so recover the path from the last ExitPlanMode result.
    // Do this before the registration below: if that fails the whole hook is skipped
    if ((await read($, planPath)) === null) {
      const path = lastExitedPlan(await $.session.messages())

      if (path !== undefined && (await $.fs.exists(path))) {
        await update($, planPath, () => path)
        await load($, path)
      } else {
        $.ui.log(`wide-plan: no plan file found to show (${path ?? 'no ExitPlanMode result in this session'})`)
      }
    }

    await $.command.register({
      name: 'plan-view',
      description: 'Show the current plan in a wide pane',
    })

    return next(e)
  })

  on('command.run', { command: 'plan-view' }, async $ => {
    const path = await read($, planPath)

    if (path === null || !(await $.fs.exists(path))) {
      return { text: 'No plan has been written in plan mode in this session.' }
    }

    await show($, path)

    return { text: 'Plan pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const path = await read($, planPath)

    // Right before approval, re-read the file so edits made elsewhere show up
    if (e.tool === 'ExitPlanMode') {
      if (path !== null && (await $.fs.exists(path))) {
        await show($, path)
      }

      const exited = await next(e)
      const filePath = (exited.result as { filePath?: unknown } | undefined)?.filePath

      // No path from the notice: show the plan file named by the tool result
      if (path === null && typeof filePath === 'string') {
        await update($, planPath, () => filePath)
        await show($, filePath)
      }

      return exited
    }

    const ran = await next(e)
    const isPlanWrite = (e.tool === 'Write' || e.tool === 'Edit') && path !== null && isSamePath(e.file_path, path)

    if (isPlanWrite && ran.deny === undefined && ran.isError !== true) {
      await show($, e.file_path)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Markdown, Text } = $.ui.resolve(e)
    const last = await read($, plan)
    // With empty state, look it up while drawing (read-only; state cannot be written during a draw)
    const path = last === null ? ((await read($, planPath)) ?? lastExitedPlan(await $.session.messages())) : undefined
    const text = last?.text ?? (path !== undefined && (await $.fs.exists(path)) ? (await $.fs.read(path)).replace(/\r/g, '') : null)

    if (text === null) {
      return <Text dimColor>No plan yet.</Text>
    }

    return <Markdown text={text} />
  })
}

// The plan-mode notice reports this session's plan file path
async function remember(
  $: EngineInterface,
  e: PromptAttachmentInput,
  next: (e: PromptAttachmentInput) => Promise<PromptAttachmentResult>,
): Promise<PromptAttachmentResult> {
  const detail = e.detail as { planFilePath?: string } | undefined
  const path = detail?.planFilePath ?? e.text.match(PLAN_PATH_IN_TEXT)?.[0]

  if (path !== undefined) {
    await update($, planPath, () => path)
  }

  return next(e)
}

function isSamePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replace(/\\/g, '/').toLowerCase()

  return normal(a) === normal(b)
}

function lastExitedPlan(messages: readonly SessionMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    for (const use of message.toolUses) {
      if (use.tool !== 'ExitPlanMode') {
        continue
      }

      // Headless hosts such as desktop store trimmed tool records, so also search the result text
      const filePath = (use.result as { filePath?: unknown } | undefined)?.filePath
      const path = typeof filePath === 'string' ? filePath : use.text?.match(PLAN_PATH_IN_TEXT)?.[0]

      if (path !== undefined) {
        return path
      }
    }
  }

  return undefined
}

async function load($: EngineInterface, path: string): Promise<void> {
  const text = (await $.fs.read(path)).replace(/\r/g, '')
  await update($, plan, () => ({ path, text }))
}

async function show($: EngineInterface, path: string): Promise<void> {
  await load($, path)
  await $.ui.open({ id: PANE, title: 'Plan', columns: 140 })
}
