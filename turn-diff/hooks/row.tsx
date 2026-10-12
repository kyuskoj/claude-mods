import type { ClientModule } from 'claude-code'

/** A foldable row. Pressing anywhere on it sends `toggle` to the hooks module. */
type FoldRow = {
  toggle: string
  isOpen: boolean
  label: string
  /** Dimmed text after the label: the turn time. */
  note?: string
  /** When set, a dimmed `N files` goes before the counts. */
  files?: number
  /** Without counts the row draws its label alone; a file row draws its counts outside, past its open button. */
  added?: number
  removed?: number
  isBold?: boolean
}

const Row: ClientModule<FoldRow> = (row, surface) => {
  const { Box, Text } = surface.elements
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
    <Box justifyContent="space-between">
      <Text bold={row.isBold} wrap="truncate-end">
        {row.isOpen ? '▾' : '▸'} {row.label}
        {row.note !== undefined && <Text dimColor> · {row.note}</Text>}
      </Text>
      {row.added !== undefined && (
        <Text>
          {row.files !== undefined && <Text dimColor>{row.files} files </Text>}
          <Text color="diffAdded">+{row.added}</Text> <Text color="diffRemoved">-{row.removed}</Text>
        </Text>
      )}
    </Box>
  )
}

export default Row
