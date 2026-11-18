import type { Register } from 'claude-code'
import { configure, createMemory, markDirty, notePaste, openImage, pictures, remove, setRequestId, start, stop } from '../src/controller'
import { addOffer, cleanupClipboard, dismissOffer } from '../src/offer'
import { PASTE_SPEC, runPaste } from '../src/paste'
import { readItems, readOffer } from '../src/state'
import { buildBand } from '../src/view'

export const register: Register = (on, options) => {
  const memory = createMemory()
  configure(memory, options)

  on('session.start', async ($, e, next) => {
    await start($, memory)
    try {
      await $.command.register(PASTE_SPEC)
    } catch {
      return next(e)
    }
    return next(e)
  })

  on('command.run', { command: 'paste' }, ($, e) => runPaste($, memory, e.args))

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    await start($, memory)
    if (e.key === undefined) notePaste(memory, e.inputText, await $.clock.now())
    markDirty(memory)
    return result
  })

  on('prompt.change', async ($, e, next) => {
    await start($, memory)
    markDirty(memory)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stop(memory)
    await cleanupClipboard($, memory)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const items = await readItems($)
    const offer = await readOffer($)
    if (items.length === 0 && offer === null) return next(e)
    setRequestId(memory, e.requestId)
    const elements = $.ui.resolve(e)
    const { Box } = elements
    const band = buildBand({
      elements,
      items,
      thumbs: memory.thumbs,
      frame: memory.frame,
      bodyColumns: e.props.bodyColumns,
      pictures: pictures(memory, e.viewport?.isFullscreen === true),
      offer,
      onRemove: (id) => {
        void remove($, memory, id)
      },
      onOpen: (id) => {
        void openImage($, memory, id)
      },
      onAdd: () => {
        void addOffer($, memory)
      },
      onDismiss: () => {
        void dismissOffer($, memory)
      },
    })
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
