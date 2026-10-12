import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptAttachmentInput, PromptAttachmentResult, Register, SessionMessage } from 'claude-code'

const PANE = 'plan'
// 엔진이 detail을 주지 않는 행(호스트 고유 플랜 안내 등)에서는 본문에 적힌 경로를 쓴다
const PLAN_PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\/)[^\s`'"]*?\.claude[\\/]plans[\\/][^\s`'"\\/]+\.md/

const plan = atom({ plugin: 'wide-plan', key: 'shown' } as const, null)
const planPath = atom({ plugin: 'wide-plan', key: 'path' } as const, null)

export const register: Register = on => {
  on('prompt.attachment', { type: 'plan_mode' }, remember)
  on('prompt.attachment', { type: 'plan_mode_reentry' }, remember)
  on('prompt.attachment', { type: 'plan_mode_exit' }, remember)

  on('session.start', async ($, e, next) => {
    // mod가 계획 모드 뒤에 로드되면 알림을 놓치므로, 마지막 ExitPlanMode 결과에서 경로를 되찾는다.
    // 아래 등록이 실패하면 훅 전체가 건너뛰어지므로 복구를 먼저 한다
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

    // 승인 직전에는 다른 경로로 고쳐진 내용까지 다시 읽어 띄운다
    if (e.tool === 'ExitPlanMode') {
      if (path !== null && (await $.fs.exists(path))) {
        await show($, path)
      }

      const exited = await next(e)
      const filePath = (exited.result as { filePath?: unknown } | undefined)?.filePath

      // 알림에서 경로를 못 받았으면 도구 결과가 알려 준 플랜 파일을 띄운다
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
    // 상태가 비어 있으면 그리는 자리에서 직접 찾는다. 그리는 중에는 상태를 쓸 수 없으므로 읽기만 한다
    const path = last === null ? ((await read($, planPath)) ?? lastExitedPlan(await $.session.messages())) : undefined
    const text = last?.text ?? (path !== undefined && (await $.fs.exists(path)) ? (await $.fs.read(path)).replace(/\r/g, '') : null)

    if (text === null) {
      return <Text dimColor>No plan yet.</Text>
    }

    return <Markdown text={text} />
  })
}

// 계획 모드 알림이 이 세션의 플랜 파일 경로를 알려 준다
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

      // 데스크톱 같은 헤드리스 호스트는 도구 기록을 줄여 저장하므로 결과 글에서도 찾는다
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
