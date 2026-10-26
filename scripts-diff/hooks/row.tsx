import type { ClientModule } from 'claude-code'

/** A foldable file row. Pressing anywhere on it sends `toggle` to the hooks module. */
type FoldRow = {
  toggle: string
  isOpen: boolean
  /** The file name. */
  label: string
  /** Dimmed after the name: the folder it is in, cut first when the row is narrow. */
  folder?: string
  /** Dimmed after the folder: the file's status. */
  note?: string
  /** Changed in the latest turn: marked before the name. */
  isRecent?: boolean
}

const Row: ClientModule<FoldRow> = (row, surface) => {
  const { Text } = surface.elements
  const press = () => surface.post({ toggle: row.toggle })

  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') {
      press()
    }
  })
  surface.onKey(event => {
    if (event.key === 'return' || event.key === ' ') {
      press()
    }
  })

  return (
    <Text wrap="truncate-end">
      {row.isOpen ? '▾' : '▸'} {row.isRecent === true && <Text color="claude">● </Text>}
      {row.label}
      {row.folder !== undefined && <Text dimColor> {row.folder}</Text>}
      {row.note !== undefined && <Text dimColor> · {row.note}</Text>}
    </Text>
  )
}

export default Row
