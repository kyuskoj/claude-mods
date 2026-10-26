import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ChangedFile } from '../types'

const PANE = 'scripts-diff'
// Per-file cap so several expanded files fit in the 100k chars Code can draw at once
const MAX_HUNKS = 30000
// Picks up edits made outside the agent (Rider, Unity) this often
const POLL_MS = 5000
// Shell tools whose file changes only show up in git
const SHELLS = new Set(['Bash', 'PowerShell'])
// $.state is gone once the app quits, so the store keeps each session's touched paths under this prefix, for the latest sessions
const SAVED = 'touched:'
const MAX_SESSIONS = 5
// Past this many touched paths git gets the whole tree instead of each path, to keep the command line short
const MAX_PATHSPECS = 200
// The most diff text one explanation sends; past it the rest is cut
const MAX_EXPLAIN = 60000

// Files that say nothing about a change: Unity's metadata, generated project files and machine-local folders
const NOISE_TYPES = new Set(['meta', 'csproj', 'sln', 'suo', 'user'])
const NOISE_FOLDERS = /^(library|temp|logs|obj|usersettings|builds?|\.vs|\.idea|\.git)\//i
const NOISE_SPECS = [':(exclude)*.meta', ':(exclude)*.csproj', ':(exclude)*.sln']
// Known binary types, skipped without reading; anything else holding a NUL byte is skipped too
const BINARY_TYPES = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'psd', 'exr', 'hdr', 'ico', 'webp'],
  ...['fbx', 'obj', 'blend', 'max', 'ma', 'mb', 'glb'],
  ...['wav', 'mp3', 'ogg', 'aif', 'aiff', 'flac', 'mp4', 'mov', 'webm', 'bank'],
  ...['ttf', 'otf', 'dll', 'exe', 'pdb', 'so', 'dylib', 'a', 'lib', 'zip', '7z', 'rar', 'unitypackage', 'bytes', 'pdf'],
])
// Group order after .cs: UI, shaders, Unity data, config, docs, scripts; the rest alphabetically, no extension last
const TYPE_ORDER = [
  ...['cs', 'uxml', 'uss', 'shader', 'hlsl', 'cginc', 'compute', 'shadergraph', 'asmdef', 'asmref'],
  ...['asset', 'prefab', 'unity', 'mat', 'controller', 'anim', 'playable', 'inputactions', 'yarn'],
  ...['json', 'yaml', 'yml', 'xml', 'txt', 'md', 'ps1', 'sh', 'bat', 'cmd', 'py'],
]

/** One file in git's diff against HEAD, untracked files included. */
type Scanned = { path: string; added: number; removed: number; hunks: string; status: 'modified' | 'added' | 'deleted' }
/** Text files keyed by the lowercased repo-relative path, and the lowercased paths of binary ones. */
type Scan = { texts: Map<string, Scanned>; binaries: Set<string> }

const touched = atom({ plugin: 'scripts-diff', key: 'touched' } as const, [])
const files = atom({ plugin: 'scripts-diff', key: 'files' } as const, [])
const expanded = atom({ plugin: 'scripts-diff', key: 'expanded' } as const, [])
const latest = atom({ plugin: 'scripts-diff', key: 'latest' } as const, { turnId: '', paths: [] })
const onlyLatest = atom({ plugin: 'scripts-diff', key: 'onlyLatest' } as const, false)
const notes = atom({ plugin: 'scripts-diff', key: 'notes' } as const, {})

// The main loop's running turn, which a subagent's edits count toward too; unknown after a reload until the next turn
let turnId: string | undefined
// The session folder's repository root, else null; asked once per load
let root: Promise<string | null> | undefined
// The program that opens each file type by default, by extension; looked up once per load
const editors = new Map<string, Promise<string | undefined>>()
let ready: Promise<void> | undefined
let poll: Timer | undefined
// One refresh at a time; a request during one runs once more after it
let running: Promise<void> | undefined
let isQueued = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    void refresh($)

    await $.command.register({
      name: 'scripts-diff',
      description: 'Show the git diff of the files changed this session, by file type',
    })

    return next(e)
  })

  on('command.run', { command: 'scripts-diff' }, async $ => {
    await ensure($)
    await openPane($)
    void refresh($)

    return { text: 'Changes pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnId = e.turnId
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Edit' || e.tool === 'Write') {
      const result = await next(e)
      const rel = repoPath(e.file_path, await repoRoot($))

      if (rel !== undefined && result.deny === undefined && !result.isError && !(result.result as { staged?: boolean }).staged) {
        await ensure($)
        await touch($, [rel])
        await refresh($)
      }

      return result
    }

    if (!SHELLS.has(e.tool)) {
      return next(e)
    }

    // A shell command changed whatever git shows differently after it
    const at = await repoRoot($)
    const before = at === null ? undefined : await detect($, at).catch(() => undefined)
    const result = await next(e)

    if (at !== null && before !== undefined) {
      const after = await detect($, at).catch(() => undefined)

      if (after !== undefined) {
        const changed = [...new Set([...before.keys(), ...after.keys()])]
          .filter(key => before.get(key)?.sig !== after.get(key)?.sig)
          .map(key => (after.get(key) ?? before.get(key))!.path)

        await ensure($)

        if (changed.length > 0) {
          await touch($, changed)
        }

        await refresh($)
      }
    }

    return result
  })

  // The row module (row.tsx) sends the pressed row's path
  on('ui.message', async ($, e, next) => {
    const toggle = (e.data as { toggle?: unknown } | null)?.toggle

    if (e.requestId === PANE && typeof toggle === 'string') {
      await update($, expanded, keys => (keys.includes(toggle) ? keys.filter(one => one !== toggle) : [...keys, toggle]))
    }

    return next(e)
  })

  // A button in the mode-label row under the prompt that opens the pane and, pressed again, closes it.
  // The engine's own drawing is not nested in the row (the desktop then drew nothing); its labels are drawn as text.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)

    if ((await repoRoot($)) === null) {
      return below
    }

    await ensure($)
    const list = (await read($, files)).filter(file => file.status !== 'clean')
    const { Box, Button, Text } = $.ui.resolve(e)
    const rest =
      below.type !== 'engine' ? below : e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null
    const totals = sum(list)

    return (
      <Box gap={1}>
        {rest}
        <Button key="toggle-changes" plain dimColor onPress={() => togglePane($)}>
          Changes
          {list.length > 0 && (
            <Text>
              {' '}
              <Text color="diffAdded">+{totals.added}</Text> <Text color="diffRemoved">-{totals.removed}</Text>
            </Text>
          )}
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Code, Button, Markdown } = elements
    // A surface without surface modules lists the files without folding
    const Client = 'Client' in elements ? elements.Client : undefined
    await ensure($)
    const open = await read($, expanded)
    const recent = new Set((await read($, latest)).paths.map(path => path.toLowerCase()))
    const isLatestOnly = await read($, onlyLatest)
    // Files back at HEAD (committed or reverted) are hidden until they change again
    const changed = (await read($, files)).filter(file => file.status !== 'clean')
    const list = isLatestOnly ? changed.filter(file => recent.has(file.path.toLowerCase())) : changed
    const at = await repoRoot($)
    const explained = await read($, notes)

    // The explanation asked for a file or a type, drawn under its row until closed
    const noteOf = (key: string, closeKey: string) => {
      const note = explained[key]

      if (note === undefined) {
        return null
      }

      const title = note.state === 'running' ? 'Explaining the intent…' : note.state === 'failed' ? `Could not explain (${note.text})` : 'Intent'

      return (
        <Box flexDirection="column" marginLeft={2} borderStyle="round" borderColor="subtle" paddingX={1}>
          <Box justifyContent="space-between">
            <Text dimColor>{title}</Text>
            <Button key={closeKey} label="close" plain dimColor onPress={() => update($, notes, all => without(all, key))} />
          </Box>
          {note.state === 'done' && <Markdown text={note.text} />}
        </Box>
      )
    }

    const fileRow = (file: ChangedFile, index: number) => {
      const isOpen = open.includes(file.path)
      const isRecent = recent.has(file.path.toLowerCase())
      const note = file.status === 'added' ? 'new' : file.status === 'deleted' ? 'deleted' : undefined
      const slash = file.path.lastIndexOf('/')
      const name = file.path.slice(slash + 1)
      const folder = slash > 0 ? file.path.slice(0, slash) : undefined
      const full = at === null ? undefined : `${at}/${file.path}`
      // The label alone goes in the row module, so the buttons beside it are no part of the row's click area
      const row = {
        toggle: file.path,
        isOpen,
        label: name,
        isRecent,
        ...(folder !== undefined && { folder }),
        ...(note !== undefined && { note }),
      }

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Box gap={1} flexShrink={1}>
              {Client !== undefined ? (
                <Client key={`f-${index}`} module="./row.tsx" props={row} />
              ) : (
                <Text wrap="truncate-end">
                  {isRecent && <Text color="claude">● </Text>}
                  {name}
                  {folder !== undefined && <Text dimColor> {folder}</Text>}
                  {note !== undefined && <Text dimColor> · {note}</Text>}
                </Text>
              )}
              {file.status !== 'deleted' && full !== undefined && (
                <Button key={`open-${index}`} label="↗" plain dimColor onPress={() => openDefault($, full)} />
              )}
              <Button key={`explain-${index}`} label="explain" plain dimColor onPress={() => explain($, file.path, [file])} />
            </Box>
            <Box flexShrink={0}>
              <Text>
                <Text color="diffAdded">+{file.added}</Text> <Text color="diffRemoved">-{file.removed}</Text>
                {file.lines !== undefined && <Text dimColor> · {file.lines} lines</Text>}
              </Text>
            </Box>
          </Box>
          {noteOf(file.path, `close-${index}`)}
          {isOpen && (
            <Box flexDirection="column" marginLeft={2}>
              {hunksOf(file.hunks).map((hunk, hunkIndex) => (
                <Box flexDirection="column">
                  {file.status === 'deleted' || full === undefined ? (
                    <Text dimColor>L{hunk.line}{hunk.context}</Text>
                  ) : (
                    <Button
                      key={`hunk-${index}-${hunkIndex}`}
                      label={`↗ L${hunk.line}${hunk.context}`}
                      plain
                      dimColor
                      onPress={() => openAt($, full, hunk.line)}
                    />
                  )}
                  <Code source={hunk.body} format="diff" path={file.path} wrap="truncate-end" />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const totals = sum(list)
    // index runs across groups, so each row's keys stay unique in the pane
    let index = 0

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text bold>
              {list.length} files{isLatestOnly ? ' in the latest turn' : ''}
            </Text>{' '}
            <Text color="diffAdded">+{totals.added}</Text> <Text color="diffRemoved">-{totals.removed}</Text>
          </Text>
          <Box gap={2} flexShrink={0}>
            <Button
              key="only-latest"
              label={isLatestOnly ? 'Show all' : 'Latest turn'}
              plain
              dimColor
              onPress={() => update($, onlyLatest, value => !value)}
            />
            <Button key="collapse-all" label="Collapse all" plain dimColor onPress={() => update($, expanded, () => [])} />
            <Button key="clear" label="Clear" plain dimColor onPress={() => clear($)} />
          </Box>
        </Box>
        {list.length === 0 && (
          <Text dimColor>{isLatestOnly ? 'The latest turn left no uncommitted changes.' : 'No uncommitted changes from this session.'}</Text>
        )}
        {groups(list).map(group => {
          const counts = sum(group.files)

          return (
            <Box flexDirection="column">
              <Box key={`type-${group.type}`} justifyContent="space-between">
                <Box gap={1} flexShrink={1}>
                  <Text>
                    <Text bold>{group.type === '' ? '(no extension)' : `.${group.type}`}</Text>
                    <Text dimColor> · {group.files.length} {group.files.length === 1 ? 'file' : 'files'}</Text>
                  </Text>
                  <Button
                    key={`explain-type-${group.type}`}
                    label="explain"
                    plain
                    dimColor
                    onPress={() => explain($, `type:${group.type}`, group.files)}
                  />
                </Box>
                <Text>
                  <Text color="diffAdded">+{counts.added}</Text> <Text color="diffRemoved">-{counts.removed}</Text>
                </Text>
              </Box>
              {noteOf(`type:${group.type}`, `close-type-${group.type}`)}
              {group.files.map(file => fileRow(file, index++))}
            </Box>
          )
        })}
      </Box>
    )
  })
}

function repoRoot($: EngineInterface): Promise<string | null> {
  return (root ??= findRoot($))
}

// Restores this session's paths and starts the poll once per load, from whichever hook runs first
function ensure($: EngineInterface): Promise<void> {
  return (ready ??= startUp($))
}

async function startUp($: EngineInterface): Promise<void> {
  await restore($)
  poll ??= $.clock.every(POLL_MS, () => void refresh($))
}

async function refresh($: EngineInterface): Promise<void> {
  if (running !== undefined) {
    isQueued = true
    return running
  }

  running = refreshOnce($)

  return running
}

async function refreshOnce($: EngineInterface): Promise<void> {
  try {
    await rebuild($, await repoRoot($))
  } catch {
    // A failed git run leaves the last diff on screen; the next poll tries again
  } finally {
    running = undefined
  }

  if (isQueued) {
    isQueued = false
    await refresh($)
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Changes', columns: 100 })
}

/** Closes the pane when it is up, from the engine's own list, and opens it otherwise. */
async function togglePane($: EngineInterface): Promise<void> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isOpen) {
    await $.ui.close({ id: PANE })
  } else {
    await openPane($)
  }
}

async function findRoot($: EngineInterface): Promise<string | null> {
  const run = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd() }).catch(() => undefined)
  const top = run?.exitCode === 0 ? run.stdout.trim().replace(/\\/g, '/') : ''

  return top !== '' ? top : null
}

/** The repo-relative path of a file worth showing, or undefined for one outside the repo, noise or binary. */
function repoPath(path: string, root: string | null): string | undefined {
  if (root === null) {
    return undefined
  }

  const normal = path.replace(/\\/g, '/')
  const prefix = `${root.replace(/\/$/, '')}/`
  const rel = normal.toLowerCase().startsWith(prefix.toLowerCase()) ? normal.slice(prefix.length) : undefined

  return rel !== undefined && isShown(rel) ? rel : undefined
}

function isShown(rel: string): boolean {
  const type = fileType(rel)

  return !NOISE_TYPES.has(type) && !BINARY_TYPES.has(type) && !NOISE_FOLDERS.test(rel)
}

/** The lowercased extension without its dot, '' for none. */
function fileType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The files by type, .cs first, each group in the list's own order (most recently touched first). */
function groups(list: readonly ChangedFile[]): { type: string; files: ChangedFile[] }[] {
  const byType = new Map<string, ChangedFile[]>()

  for (const file of list) {
    const type = fileType(file.path)
    byType.set(type, [...(byType.get(type) ?? []), file])
  }

  const rank = (type: string) => {
    const at = TYPE_ORDER.indexOf(type)

    return at >= 0 ? at : type === '' ? TYPE_ORDER.length + 1 : TYPE_ORDER.length
  }

  return [...byType]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([type, group]) => ({ type, files: group }))
}

/** Moves the paths to the front of this session's list and keeps it past a restart. */
async function touch($: EngineInterface, paths: readonly string[]): Promise<void> {
  const keys = new Set(paths.map(path => path.toLowerCase()))
  const list = await update($, touched, old => [...paths, ...old.filter(one => !keys.has(one.toLowerCase()))])
  // The latest turn's set starts over with the first change of a new turn, so a turn that changes nothing keeps the last one's
  await update($, latest, old => {
    const id = turnId ?? old.turnId
    const kept = old.turnId === id ? old.paths.filter(one => !keys.has(one.toLowerCase())) : []

    return { turnId: id, paths: [...paths, ...kept] }
  })
  // A store that fails costs only the copy kept past a restart
  await save($, list).catch(() => undefined)
}

async function clear($: EngineInterface): Promise<void> {
  await update($, touched, () => [])
  await update($, files, () => [])
  await update($, expanded, () => [])
  await update($, latest, () => ({ turnId: '', paths: [] }))
  await save($, []).catch(() => undefined)
}

/**
 * Asks, beside the conversation, what the files' changes are for: a fork of the session's own transcript, so the answer
 * knows the requests behind them, with no tools and nothing added to the conversation. The answer lands under `key`.
 */
async function explain($: EngineInterface, key: string, list: readonly ChangedFile[]): Promise<void> {
  await update($, notes, all => ({ ...all, [key]: { state: 'running' as const, text: '' } }))
  // A press's dispatch ends with its handler, sooner than a fork answers; a timer runs the fork on its own
  $.clock.after(0, () => void answerExplain($, key, list))
}

async function answerExplain($: EngineInterface, key: string, list: readonly ChangedFile[]): Promise<void> {
  const reply = await $.model.fork({ prompt: explainPrompt(list) }).catch(() => undefined)
  const note = reply?.isAnswered
    ? ({ state: 'done', text: reply.text.trim() } as const)
    : ({ state: 'failed', text: reply === undefined ? 'error' : reply.reason } as const)

  // Closed while it ran: the answer goes nowhere
  await update($, notes, all => (key in all ? { ...all, [key]: note } : all))
}

function explainPrompt(list: readonly ChangedFile[]): string {
  let budget = MAX_EXPLAIN
  const diffs = list.map(file => {
    const hunks = file.hunks.slice(0, Math.max(budget, 0))
    budget -= hunks.length
    const cut = hunks.length < file.hunks.length ? '\n(이하 생략)' : ''

    return `### \`${file.path}\` (${file.status === 'added' ? '새 파일' : file.status === 'deleted' ? '삭제' : '수정'})\n\`\`\`diff\n${hunks}\`\`\`${cut}`
  })

  return [
    '아래는 이 세션에서 바뀐 파일의 변경 내용(HEAD 기준 git diff)이다.',
    '버그, 위험, 개선점은 찾지 마라. 이 변경이 무엇을 왜 바꿨는지, 변경 의도만 설명하라.',
    '- 이 대화에서 나온 요청과 맥락을 근거로 삼아라.',
    '- 한국어로, 파일마다 2~4문장으로 짧게 답하라.',
    '- 도구는 쓰지 말고 아래 diff만 보고 답하라.',
    '',
    ...diffs,
  ].join('\n')
}

function without<T>(all: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const rest = { ...all }
  delete rest[key]

  return rest
}

/** A diff's hunks, each with the line its first change lands on in the file now and git's context text. */
function hunksOf(hunks: string): { line: number; context: string; body: string }[] {
  return hunks
    .split(/^(?=@@ )/m)
    .filter(hunk => hunk.startsWith('@@ '))
    .map(hunk => {
      const [header = '', ...lines] = hunk.replace(/\n$/, '').split('\n')
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(header)
      let line = Number(match?.[1] ?? 1)

      // Context lines before the first change sit above it
      for (const one of lines) {
        if (!one.startsWith(' ')) {
          break
        }

        line++
      }

      const context = match?.[2]?.trim()

      // The header stays in the body: Code draws a diff only from its @@ line
      return { line: Math.max(line, 1), context: context ? `  ${context}` : '', body: `${header}\n${lines.join('\n')}\n` }
    })
}

/**
 * Opens the file at a line in the program the OS opens its type with, when that program takes a line:
 * VS Code and its forks (`-g path:line`), JetBrains Rider (`--line`). Any other opens the file alone.
 */
async function openAt($: EngineInterface, path: string, line: number): Promise<void> {
  if (!(await $.fs.exists(path))) {
    $.ui.toast(`scripts-diff: ${path} no longer exists`)
    return
  }

  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const native = isWindows ? path.replace(/\//g, '\\') : path
  const editor = isWindows ? await editorFor($, fileType(path)) : 'code'
  const name = editor?.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const args = /^(code|code - insiders|cursor|windsurf|vscodium)(\.exe)?$/.test(name)
    ? ['-g', `${native}:${line}`]
    : /^rider(64)?(\.exe)?$/.test(name)
      ? ['--line', String(line), native]
      : undefined

  if (editor === undefined || args === undefined) {
    await openDefault($, path)
    return
  }

  if (!isWindows) {
    const run = await $.process.run([editor, ...args]).catch(() => undefined)

    if (run?.exitCode !== 0) {
      await openDefault($, path)
    }

    return
  }

  // Start-Process returns at once; run directly, an editor that was not running would hold the call until it quits
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  await $.process.run([
    'powershell',
    '-NoProfile',
    '-Command',
    `Start-Process -FilePath ${quote(editor)} -ArgumentList ${args.map(arg => quote(arg.includes(' ') ? `"${arg}"` : arg)).join(',')}`,
  ])
}

/** The executable Windows opens files of this type with: the person's own pick first, else the type's registered program. */
function editorFor($: EngineInterface, type: string): Promise<string | undefined> {
  let found = editors.get(type)

  if (found === undefined) {
    found = lookUpEditor($, type).catch(() => undefined)
    editors.set(type, found)
  }

  return found
}

async function lookUpEditor($: EngineInterface, type: string): Promise<string | undefined> {
  const value = async (key: string, name?: string) => {
    const run = await $.process.run(['reg', 'query', key, ...(name === undefined ? ['/ve'] : ['/v', name])])

    return run.exitCode === 0 ? /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(run.stdout.replace(/\r/g, ''))?.[1]?.trim() : undefined
  }
  const progId =
    (await value(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.${type}\\UserChoice`, 'ProgId')) ??
    (await value(`HKCR\\.${type}`))
  const command = progId === undefined ? undefined : await value(`HKCR\\${progId}\\shell\\open\\command`)
  const exe = command === undefined ? undefined : command.startsWith('"') ? command.slice(1, command.indexOf('"', 1)) : command.split(' ')[0]

  if (exe === undefined) {
    return undefined
  }

  // REG_EXPAND_SZ values name folders by variable; these are the ones program paths use
  const folders: Record<string, string | undefined> = {
    localappdata: await $.env.get('LOCALAPPDATA'),
    appdata: await $.env.get('APPDATA'),
    userprofile: await $.env.get('USERPROFILE'),
    programfiles: await $.env.get('ProgramFiles'),
    'programfiles(x86)': await $.env.get('ProgramFiles(x86)'),
    systemroot: await $.env.get('SystemRoot'),
  }

  return exe.replace(/%([^%]+)%/g, (whole, name: string) => folders[name.toLowerCase()] ?? whole)
}

async function git($: EngineInterface, root: string, args: readonly string[]): Promise<string> {
  const run = await $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: root })

  if (run.exitCode !== 0) {
    throw new Error(run.stderr)
  }

  return run.stdout.replace(/\r/g, '')
}

/** Splits `git diff` output into one entry per text file, and names the binary files apart. */
function parseDiff(diff: string): { texts: Scanned[]; binaries: string[] } {
  const result: Scanned[] = []
  const binaries: string[] = []

  for (const block of diff.split(/^diff --git /m).slice(1)) {
    // A binary file has no ---/+++ lines; its path is the header's `b/` side (git spells both sides alike without renames)
    if (/^Binary files /m.test(block)) {
      const header = /^a\/.+ b\/(.+)$/m.exec(block)?.[1]

      if (header !== undefined) {
        binaries.push(header)
      }

      continue
    }

    const path = /^\+\+\+ b\/(.+)$/m.exec(block)?.[1] ?? /^--- a\/(.+)$/m.exec(block)?.[1]

    if (path === undefined || !isShown(path)) {
      continue
    }

    const hunks = block.replace(/^[\s\S]*?(?=^@@)/m, '')
    const lines = hunks.startsWith('@@') ? hunks.split('\n') : []

    result.push({
      path,
      added: lines.filter(line => line.startsWith('+')).length,
      removed: lines.filter(line => line.startsWith('-')).length,
      hunks: lines.length > 0 ? hunks : '',
      status: /^new file mode/m.test(block) ? 'added' : /^deleted file mode/m.test(block) ? 'deleted' : 'modified',
    })
  }

  return { texts: result, binaries }
}

/**
 * What git shows changed in the whole repository now, each file with a signature that changes with its content:
 * the zero-context diff for a tracked file, size and time for an untracked one (whose content git does not diff).
 */
async function detect($: EngineInterface, root: string): Promise<Map<string, { path: string; sig: string }>> {
  const specs = ['--', '.', ...NOISE_SPECS]
  const [diff, untracked] = await Promise.all([
    git($, root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U0', ...specs]),
    git($, root, ['ls-files', '--others', '--exclude-standard', ...specs]),
  ])
  const result = new Map<string, { path: string; sig: string }>()

  for (const file of parseDiff(diff).texts) {
    result.set(file.path.toLowerCase(), { path: file.path, sig: `${file.status}\n${file.hunks}` })
  }

  for (const path of untracked.split('\n').filter(path => path !== '' && isShown(path))) {
    const stat = await $.fs.stat(`${root}/${path}`).catch(() => undefined)
    result.set(path.toLowerCase(), { path, sig: stat === undefined ? 'gone' : `new ${stat.size} ${stat.mtimeMs}` })
  }

  return result
}

/** git's diff of the given paths against HEAD with context, untracked text files as all added. */
async function scan($: EngineInterface, root: string, paths: readonly string[]): Promise<Scan> {
  const specs = paths.length > MAX_PATHSPECS ? ['--', '.', ...NOISE_SPECS] : ['--', ...paths.map(path => `:(literal)${path}`)]
  const [diff, untracked] = await Promise.all([
    git($, root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U3', ...specs]),
    git($, root, ['ls-files', '--others', '--exclude-standard', ...specs]),
  ])
  const parsed = parseDiff(diff)
  const result: Scan = {
    texts: new Map(parsed.texts.map(file => [file.path.toLowerCase(), file])),
    binaries: new Set(parsed.binaries.map(path => path.toLowerCase())),
  }

  for (const path of untracked.split('\n').filter(path => path !== '' && isShown(path))) {
    const text = (await $.fs.read(`${root}/${path}`).catch(() => '')).replace(/\r/g, '')

    if (text.includes('\0')) {
      result.binaries.add(path.toLowerCase())
      continue
    }

    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')

    result.texts.set(path.toLowerCase(), {
      path,
      added: lines.length,
      removed: 0,
      hunks: lines.length > 0 ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n` : '',
      status: 'added',
    })
  }

  return result
}

/** Recomputes the touched files' diffs and writes them only when something changed, so the pane redraws only then. */
async function rebuild($: EngineInterface, root: string | null): Promise<void> {
  const paths = (await read($, touched)).filter(isShown)

  if (root === null || paths.length === 0) {
    return
  }

  const scanned = await scan($, root, paths)
  const next: ChangedFile[] = []

  for (const rel of paths) {
    const entry = scanned.texts.get(rel.toLowerCase())
    const path = entry?.path ?? rel
    const text = entry?.status === 'deleted' ? null : await $.fs.read(`${root}/${path}`).catch(() => null)

    // Binary after all: a file git called binary, or one holding a NUL byte
    if (scanned.binaries.has(rel.toLowerCase()) || text?.includes('\0') === true) {
      continue
    }

    const hunks = entry?.hunks ?? ''

    next.push({
      path,
      added: entry?.added ?? 0,
      removed: entry?.removed ?? 0,
      ...(text !== null && { lines: lineCount(text.replace(/\r/g, '')) }),
      hunks: hunks.length > MAX_HUNKS ? hunks.slice(0, Math.max(hunks.lastIndexOf('\n@@', MAX_HUNKS), 0)) : hunks,
      status: entry?.status ?? (text === null ? 'deleted' : 'clean'),
    })
  }

  // A clear while git ran leaves the list empty
  if ((await read($, touched)).length === 0) {
    return
  }

  if (JSON.stringify(next) !== JSON.stringify(await read($, files))) {
    await update($, files, () => next)
  }
}

// After the app restarts the session's paths are only in the store; a hot reload keeps them in $.state
async function restore($: EngineInterface): Promise<void> {
  if ((await read($, touched)).length > 0) {
    return
  }

  const saved = await $.session
    .id()
    .then(id => $.store.get(`${SAVED}${id}`))
    .catch(() => undefined)

  if (Array.isArray(saved) && saved.length > 0) {
    await update($, touched, list => (list.length === 0 ? (saved as string[]) : list))
  }
}

async function save($: EngineInterface, paths: readonly string[]): Promise<void> {
  const key = `${SAVED}${await $.session.id()}`
  // Deleting first moves this session last in the store's insertion order, so the oldest sessions come first
  await $.store.delete(key)
  const older = (await $.store.keys()).filter(one => one.startsWith(SAVED))

  for (const one of older.splice(0, Math.max(older.length - (MAX_SESSIONS - 1), 0))) {
    await $.store.delete(one)
  }

  await $.store.set(key, paths)
}

function sum(list: readonly ChangedFile[]): { added: number; removed: number } {
  return {
    added: list.reduce((total, file) => total + file.added, 0),
    removed: list.reduce((total, file) => total + file.removed, 0),
  }
}

// Counts lines the way git does: a last line without a newline still counts
function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

// Opens the file with the program the OS associates with it; no plugin API does this, so ask the OS shell
async function openDefault($: EngineInterface, path: string): Promise<void> {
  if (!(await $.fs.exists(path))) {
    $.ui.toast(`scripts-diff: ${path} no longer exists`)
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
    $.ui.toast(`scripts-diff: could not open ${path}`)
  }
}
