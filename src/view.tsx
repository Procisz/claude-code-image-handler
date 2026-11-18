import type { Elements, RenderElement } from 'claude-code'
import type { ClipboardOffer, PreviewItem } from '../types'
import type { RawImage } from './decode/types'
import { PICTURE_ROWS, TILE_BORDER, TILE_GAP, pictureBox, spinnerCells, tileInnerWidth, tilesPerRow } from './layout'
import { wrapName } from './names'

export type Thumb = {
  image: RawImage
  rgba: string
}

export type BandOptions = {
  elements: Elements['terminal']
  items: readonly PreviewItem[]
  thumbs: ReadonlyMap<string, Thumb>
  frame: number
  bodyColumns: number
  pictures: boolean
  offer: ClipboardOffer | null
  onRemove: (id: string) => void
  onOpen: (id: string) => void
  onAdd: () => void
  onDismiss: () => void
}

export const CLIPBOARD_ID = 'clipboard'
export const CLIPBOARD_LABEL = 'Clipboard picture'
export const HINT = 'ctrl+x tab: focus previews, Tab: next, Enter: press, Esc: back'

function tileBody(options: BandOptions, item: PreviewItem): RenderElement {
  const { Box, Image, Raster, Text } = options.elements
  const thumb = options.thumbs.get(item.id)
  if (item.status === 'failed') {
    return <Text dimColor>No preview</Text>
  }
  if (item.status === 'ready' && thumb !== undefined) {
    const { columns, rows } = pictureBox(item.width, item.height, tileInnerWidth(options.bodyColumns))
    return (
      <Image
        key={`picture:${item.id}`}
        source={{ rgba: thumb.rgba, width: thumb.image.width, height: thumb.image.height }}
        columns={columns}
        rows={rows}
        alt={`Preview of ${item.label}`}
      />
    )
  }
  return (
    <Box flexDirection="column" alignItems="center">
      <Raster key={`spinner:${item.id}`} columns={1} rows={1} cells={spinnerCells(options.frame)} />
      <Text dimColor>Loading</Text>
    </Box>
  )
}

function tile(options: BandOptions, item: PreviewItem, header: RenderElement): RenderElement {
  const { Box, Text } = options.elements
  const innerWidth = tileInnerWidth(options.bodyColumns)
  const body = options.pictures
    ? [
        <Box
          key={`body:${item.id}`}
          width={innerWidth}
          height={PICTURE_ROWS}
          alignItems="center"
          justifyContent="center"
        >
          {tileBody(options, item)}
        </Box>,
      ]
    : []
  const name = wrapName(item.label, innerWidth).map((line, index) => (
    <Text key={`name:${item.id}:${index}`}>{line}</Text>
  ))
  return (
    <Box
      key={`tile:${item.id}`}
      flexDirection="column"
      width={innerWidth + TILE_BORDER}
      borderStyle="round"
      borderDimColor
    >
      {header}
      {body}
      {name}
    </Box>
  )
}

function itemTile(options: BandOptions, item: PreviewItem): RenderElement {
  const { Box, Button } = options.elements
  const header = (
    <Box justifyContent="space-between">
      <Button key={`open:${item.id}`} label={`Open ${item.label}`} onPress={() => options.onOpen(item.id)}>
        open
      </Button>
      <Button key={`remove:${item.id}`} label={`Remove ${item.label}`} onPress={() => options.onRemove(item.id)}>
        x
      </Button>
    </Box>
  )
  return tile(options, item, header)
}

function clipboardTile(options: BandOptions, offer: ClipboardOffer): RenderElement {
  const { Box, Button } = options.elements
  const item: PreviewItem = { id: CLIPBOARD_ID, kind: 'path', label: CLIPBOARD_LABEL, ...offer }
  const header = (
    <Box justifyContent="space-between">
      <Button key={`add:${CLIPBOARD_ID}`} label="Add clipboard picture" variant="primary" onPress={options.onAdd}>
        Add
      </Button>
      <Button key={`dismiss:${CLIPBOARD_ID}`} label="Dismiss clipboard picture" onPress={options.onDismiss}>
        x
      </Button>
    </Box>
  )
  return tile(options, item, header)
}

export function buildBand(options: BandOptions): RenderElement {
  const { Box, Text } = options.elements
  const perRow = tilesPerRow(options.bodyColumns)
  const tiles = options.items.map((item) => itemTile(options, item))
  if (options.offer !== null) tiles.push(clipboardTile(options, options.offer))
  const rows: RenderElement[][] = []
  for (let start = 0; start < tiles.length; start += perRow) {
    rows.push(tiles.slice(start, start + perRow))
  }
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Box key={`row:${index}`} flexDirection="row" columnGap={TILE_GAP}>
          {row}
        </Box>
      ))}
      <Text dimColor wrap="truncate">
        {HINT}
      </Text>
    </Box>
  )
}
