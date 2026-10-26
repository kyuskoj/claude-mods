import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  title: 'Changes',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const
const FOOTER = { modes: [] }
const A = 'Assets/Scripts/Player/Mover.cs'
const DIFF_A =
  `diff --git a/${A} b/${A}\r\nindex 1..2 100644\r\n--- a/${A}\r\n+++ b/${A}\r\n` + '@@ -1,2 +1,3 @@\r\n a\r\n-b\r\n+c\r\n+d\r\n'

/** One file's block in `git diff` output, adding `added` lines to a file that had one. */
function diffOf(path: string, added: number): string {
  const lines = Array.from({ length: added }, (_, at) => `+line ${at}\n`).join('')

  return `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${added + 1} @@\n a\n${lines}`
}

/** What git and the disk say; a test changes it as files change. */
type Repo = {
  diff: string
  untracked: string[]
  files: Record<string, string>
  isRepo?: boolean
  onBash?: () => void
  /** Every command the mod ran that is not git. */
  runs?: string[][]
  /** Every side question the mod asked. */
  prompts?: string[]
}

// What reg.exe prints for the .cs UserChoice and VS Code's open command
const REG = {
  choice: '\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    Applications\\Code.exe\r\n',
  command:
    '\r\nHKEY_CLASSES_ROOT\\Applications\\Code.exe\\shell\\open\\command\r\n' +
    '    (Default)    REG_SZ    "%LOCALAPPDATA%\\Programs\\VS Code\\Code.exe" "%1"\r\n',
}

function world(on: On, repo: Repo, opened: string[] = [], store = new Map<string, unknown>()): void {
  on('process.run', ($, e) => {
    const git = e.argv.filter(arg => !arg.startsWith('core.') && arg !== '-c')

    if (e.argv[0] !== 'git') {
      repo.runs?.push([...e.argv])
      const key = e.argv[2] ?? ''
      const stdout = e.argv[0] !== 'reg' ? '' : key.endsWith('UserChoice') ? REG.choice : key.endsWith('Code.exe\\shell\\open\\command') ? REG.command : ''

      return { value: { exitCode: e.argv[0] === 'reg' && stdout === '' ? 1 : 0, stdout, stderr: '' } } as never
    }

    if (git[1] === 'rev-parse') {
      return { value: repo.isRepo === false ? { exitCode: 128, stdout: '', stderr: 'not a git repository' } : { exitCode: 0, stdout: 'D:/Beak\n', stderr: '' } } as never
    }

    const stdout = git[1] === 'diff' ? repo.diff : git[1] === 'ls-files' ? repo.untracked.join('\n') : ''

    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  // The engine hands paths over in the platform's spelling
  const slash = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
  on('fs.read', ($, e) => {
    const text = repo.files[slash(e.path)]

    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: repo.files[slash(e.path)] !== undefined }))
  on('fs.stat', ($, e) => {
    const text = repo.files[slash(e.path)]

    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } } as never
  })
  on('env.get', ($, e) => ({ value: ({ OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as Record<string, string>)[e.name] }))
  // Stands for the side question over the session's transcript
  on('model.fork', ($, e) => {
    repo.prompts?.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

    return { value: { isAnswered: true, text: '이동 속도를 바꿨다.', usage } } as never
  })
  on('session.cwd', () => ({ value: 'D:\\Beak' }))
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
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') {
      repo.onBash?.()
    }

    return { result: {} as never }
  })
  // Stands for the engine's own mode labels
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: '' }))
}

function edit($: Engine, path: string): Promise<unknown> {
  return $.tool.call({ tool: 'Edit', file_path: path, old_string: 'b', new_string: 'c\nd' })
}

function mountPane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'scripts-diff', surface, component: 'Pane', requestId: 'scripts-diff', props: PANE })
}

test('shows an edited file with its counts and line count as soon as the edit lands', async ($, on) => {
  mock.clock(on)
  const repo: Repo = { diff: DIFF_A, untracked: [], files: { [`D:/Beak/${A}`]: 'a\r\nc\r\nd\r\n' } }
  world(on, repo)

  // Mid-turn: no turn.complete needed
  await edit($, `D:\\Beak\\${A.replace(/\//g, '\\')}`)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /1 files/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ ● Mover\.cs Assets\/Scripts\/Player/, in: 'f-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 lines/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'f-0' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'f-0' })
    await ui.unmount()

    const band = await $.ui.mount({ plugin: 'scripts-diff', surface, component: 'SessionMode', props: FOOTER })
    expect(await band.find({ key: 'toggle-changes', text: /Changes \+2 -1/ })).toBeDefined()
    await band.unmount()
  }
})

test('groups the files by type, .cs first, each header with its own totals', async ($, on) => {
  mock.clock(on)
  const uss = 'Assets/UI/Hud.uss'
  const md = 'Docs/Notes.md'
  const md2 = 'README.md'
  const repo: Repo = {
    diff: DIFF_A + diffOf(uss, 1) + diffOf(md, 2) + diffOf(md2, 3),
    untracked: [],
    files: { [`D:/Beak/${A}`]: 'a\nc\nd\n', [`D:/Beak/${uss}`]: 'a\nb\n', [`D:/Beak/${md}`]: 'a\nb\nc\n', [`D:/Beak/${md2}`]: 'a\nb\nc\nd\n' },
  }
  world(on, repo)

  // Touched in the opposite order to the groups
  await edit($, `D:/Beak/${md2}`)
  await edit($, `D:/Beak/${md}`)
  await edit($, `D:/Beak/${uss}`)
  await edit($, `D:/Beak/${A}`)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /4 files/ })).toBeDefined()
    // Rows run .cs, .uss, then .md, most recently touched first within a type
    expect(await ui.find({ type: 'Text', text: /Mover\.cs/, in: 'f-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Hud\.uss/, in: 'f-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Notes\.md/, in: 'f-2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /README\.md/, in: 'f-3' })).toBeDefined()

    // Collapse all folds every open diff at once
    await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'f-0' })
    await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'f-2' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'collapse-all' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()

    // Each header carries its type's file count, its explain button and its totals
    expect((await ui.find({ key: 'type-cs' }))?.text).toBe('.cs · 1 fileexplain+2 -1')
    expect((await ui.find({ key: 'type-uss' }))?.text).toBe('.uss · 1 fileexplain+1 -0')
    expect((await ui.find({ key: 'type-md' }))?.text).toBe('.md · 2 filesexplain+5 -0')
    await ui.unmount()
  }
})

test('leaves out files outside the repository, Unity metadata and binary files', async ($, on) => {
  mock.clock(on)
  const repo: Repo = {
    diff: `diff --git a/Assets/Art/Icon.asset b/Assets/Art/Icon.asset\nindex 1..2 100644\nBinary files a/Assets/Art/Icon.asset and b/Assets/Art/Icon.asset differ\n`,
    untracked: ['Assets/Data/blob.dat'],
    files: { 'D:/Beak/Assets/Data/blob.dat': 'MZ\0\0binary' },
  }
  world(on, repo)

  await edit($, 'D:/Beakers/Assets/Scripts/a.cs')
  await edit($, 'C:/Users/me/AppData/Local/Temp/scratchpad/probe.cs')
  await edit($, 'D:/Beak/Assets/Scripts/Player/Mover.cs.meta')
  await edit($, 'D:/Beak/Assembly-CSharp.csproj')
  await edit($, 'D:/Beak/Library/ScriptAssemblies/x.txt')
  await $.tool.call({ tool: 'Write', file_path: 'D:/Beak/Assets/Art/icon.png', content: 'x' })
  // Text-like names that turn out binary: by git's word, or by a NUL byte in an untracked file
  await edit($, 'D:/Beak/Assets/Art/Icon.asset')
  await $.tool.call({ tool: 'Write', file_path: 'D:/Beak/Assets/Data/blob.dat', content: 'x' })

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /No uncommitted changes from this session/ })).toBeDefined()
  await ui.unmount()
})

test('shows a new untracked file as all added', async ($, on) => {
  mock.clock(on)
  const path = 'Assets/UI/New.uxml'
  const repo: Repo = { diff: '', untracked: [path], files: { [`D:/Beak/${path}`]: '<a>\n</a>\n' } }
  world(on, repo)

  await $.tool.call({ tool: 'Write', file_path: `D:/Beak/${path}`, content: '<a>\n</a>\n' })

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /New\.uxml Assets\/UI · new/, in: 'f-0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 lines/ })).toBeDefined()
  await ui.unmount()
})

test('picks up files a shell command changed, whatever their type', async ($, on) => {
  mock.clock(on)
  const json = 'Packages/manifest.json'
  const repo: Repo = { diff: '', untracked: [], files: { [`D:/Beak/${A}`]: 'a\nc\nd\n', [`D:/Beak/${json}`]: '{\n}\n' } }
  repo.onBash = () => {
    repo.diff = DIFF_A + diffOf(json, 1)
  }
  world(on, repo)

  await $.tool.call({ tool: 'Bash', command: "sed -i 's/b/c/' Assets/Scripts/Player/Mover.cs Packages/manifest.json" })

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /Mover\.cs/, in: 'f-0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /manifest\.json/, in: 'f-1' })).toBeDefined()
  await ui.unmount()
})

test('follows edits made outside the agent on the poll, and marks a committed file', async ($, on) => {
  const clock = mock.clock(on)
  const repo: Repo = { diff: DIFF_A, untracked: [], files: { [`D:/Beak/${A}`]: 'a\nc\nd\n' } }
  world(on, repo)

  await edit($, `D:/Beak/${A}`)

  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /\+2/ })).toBeDefined()

  // Edited in Rider: one more added line
  repo.diff = DIFF_A + '+e\r\n'
  repo.files[`D:/Beak/${A}`] = 'a\nc\nd\ne\n'
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /\+3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4 lines/ })).toBeDefined()

  // Committed: the row goes, and comes back once the file changes again
  repo.diff = ''
  await clock.advance(5000)
  expect(await ui.find({ key: 'f-0' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No uncommitted changes from this session/ })).toBeDefined()

  repo.diff = DIFF_A
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Mover\.cs/, in: 'f-0' })).toBeDefined()
  await ui.unmount()
})

test('keeps the touched paths past a restart, for the latest five sessions', async ($, on) => {
  mock.clock(on)
  const store = new Map<string, unknown>([1, 2, 3, 4, 5].map(no => [`touched:old${no}`, []]))
  const repo: Repo = { diff: DIFF_A, untracked: [], files: { [`D:/Beak/${A}`]: 'a\nc\nd\n' } }
  world(on, repo, [], store)

  await edit($, `D:/Beak/${A}`)

  expect([...store.keys()]).toEqual(['touched:old2', 'touched:old3', 'touched:old4', 'touched:old5', 'touched:s1'])
  expect(store.get('touched:s1')).toEqual([A])
})

test('brings the touched paths back from the store when the app starts the session again', async ($, on) => {
  mock.clock(on)
  const repo: Repo = { diff: DIFF_A, untracked: [], files: { [`D:/Beak/${A}`]: 'a\nc\nd\n' } }
  world(on, repo, [], new Map([['touched:s1', [A]]]))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)

  await $.session.start({ cwd: 'D:\\Beak', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ plugin: 'scripts-diff', surface: 'desktop', component: 'SessionMode', props: FOOTER })
  expect(await band.find({ key: 'toggle-changes', text: /Changes \+2 -1/ })).toBeDefined()
  await band.unmount()
})

test('the button under the prompt opens the pane and closes it again', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  const closed: string[] = []
  world(on, { diff: '', untracked: [], files: {} }, opened)
  on('ui.panes', () => ({ value: opened.length > closed.length ? [{ id: 'scripts-diff' }] : [] }) as never)
  on('ui.close', ($, e) => {
    closed.push(e.id)

    return { value: undefined } as never
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'scripts-diff', surface, component: 'SessionMode', props: FOOTER })
    expect(await band.find({ key: 'toggle-changes', text: /^Changes$/ })).toBeDefined()

    await band.press({ key: 'toggle-changes' })
    expect(opened[opened.length - 1]).toBe('scripts-diff')
    await band.press({ key: 'toggle-changes' })
    expect(closed[closed.length - 1]).toBe('scripts-diff')
    await band.unmount()
  }
})

test('stays out of the way outside a git repository', async ($, on) => {
  mock.clock(on)
  world(on, { diff: '', untracked: [], files: {}, isRepo: false })

  const band = await $.ui.mount({ plugin: 'scripts-diff', surface: 'desktop', component: 'SessionMode', props: FOOTER })
  expect(await band.find({ key: 'toggle-changes' })).toBeUndefined()
  await band.unmount()
})

test('marks the files of the latest turn that changed any, and can show only those', async ($, on) => {
  mock.clock(on)
  const uss = 'Assets/UI/Hud.uss'
  const repo: Repo = { diff: DIFF_A + diffOf(uss, 1), untracked: [], files: { [`D:/Beak/${A}`]: 'a\nc\nd\n', [`D:/Beak/${uss}`]: 'a\nb\n' } }
  world(on, repo)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: 'one', turnId: 't1' })
  await edit($, `D:/Beak/${A}`)
  await $.turn.start({ text: 'two', turnId: 't2' })
  await edit($, `D:/Beak/${uss}`)
  // A turn that changes nothing keeps the last one's marks
  await $.turn.start({ text: 'three', turnId: 't3' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /▸ Mover\.cs/, in: 'f-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ ● Hud\.uss/, in: 'f-1' })).toBeDefined()

    await ui.press({ key: 'only-latest' })
    expect(await ui.find({ type: 'Text', text: /1 files in the latest turn/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Hud\.uss/, in: 'f-0' })).toBeDefined()
    expect(await ui.find({ key: 'f-1' })).toBeUndefined()

    await ui.press({ key: 'only-latest' })
    expect(await ui.find({ key: 'f-1' })).toBeDefined()
    await ui.unmount()
  }
})

test('each hunk opens the file at its first changed line in the editor Windows uses for the type', async ($, on) => {
  mock.clock(on)
  const runs: string[][] = []
  // Two context lines before the change at line 12
  const diff = `diff --git a/${A} b/${A}\n--- a/${A}\n+++ b/${A}\n@@ -10,4 +10,5 @@ class Mover\n x\n y\n-b\n+c\n+d\n z\n`
  const repo: Repo = { diff, untracked: [], files: { [`D:/Beak/${A}`]: 'x\n' }, runs }
  world(on, repo)

  await edit($, `D:/Beak/${A}`)

  const ui = await mountPane($, 'desktop')
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'f-0' })
  expect(await ui.find({ key: 'hunk-0-0', text: /L12 {2}class Mover/ })).toBeDefined()

  await ui.press({ key: 'hunk-0-0' })
  const start = runs.find(run => run[0] === 'powershell')
  expect(start?.[3]).toBe(
    "Start-Process -FilePath 'C:\\Users\\me\\AppData\\Local\\Programs\\VS Code\\Code.exe' -ArgumentList '-g','D:\\Beak\\Assets\\Scripts\\Player\\Mover.cs:12'",
  )
  await ui.unmount()
})

test('explain asks a side question about the intent and shows the answer under the file or type', async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const md = 'Docs/Notes.md'
  const repo: Repo = { diff: DIFF_A + diffOf(md, 1), untracked: [], files: { [`D:/Beak/${A}`]: 'a\n', [`D:/Beak/${md}`]: 'a\n' }, prompts }
  world(on, repo)

  await edit($, `D:/Beak/${md}`)
  await edit($, `D:/Beak/${A}`)

  for (const surface of ['terminal', 'desktop'] as const) {
    prompts.length = 0
    const ui = await mountPane($, surface)
    await ui.press({ key: 'explain-0' })
    await clock.settle()
    // In Korean, about intent, never a bug hunt, with that file's diff alone
    expect(prompts[0]).toContain('변경 의도만 설명하라')
    expect(prompts[0]).toContain('버그, 위험, 개선점은 찾지 마라')
    expect(prompts[0]).toContain(`### \`${A}\` (수정)`)
    expect(prompts[0]).not.toContain(md)
    expect(await ui.find({ type: 'Markdown', text: /이동 속도를 바꿨다/ })).toBeDefined()

    await ui.press({ key: 'close-0' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

    await ui.press({ key: 'explain-type-md' })
    await clock.settle()
    expect(prompts[1]).toContain(`### \`${md}\``)
    expect(prompts[1]).not.toContain(A)
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    await ui.press({ key: 'close-type-md' })
    await ui.unmount()
  }
})
