import type { ClientModule } from 'claude-code'

/** 접고 펴는 한 행. 행 어디를 눌러도 훅 모듈에 `toggle`을 보낸다. */
type FoldRow = {
  toggle: string
  isOpen: boolean
  label: string
  /** 레이블 뒤에 흐리게 붙는 글: 턴의 시각. */
  note?: string
  /** 있으면 수치 앞에 `N files`를 흐리게 붙인다. */
  files?: number
  added: number
  removed: number
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
      <Text>
        {row.files !== undefined && <Text dimColor>{row.files} files </Text>}
        <Text color="diffAdded">+{row.added}</Text> <Text color="diffRemoved">-{row.removed}</Text>
      </Text>
    </Box>
  )
}

export default Row
