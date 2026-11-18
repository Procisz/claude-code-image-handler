import type { StateDollar } from 'claude-code'
import type { ClipboardOffer, PreviewItem } from '../types'

const KINDS: readonly unknown[] = ['tag', 'path']
const STATUSES: readonly unknown[] = ['loading', 'ready', 'failed']

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isItem(value: unknown): value is PreviewItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    KINDS.includes(item.kind) &&
    typeof item.label === 'string' &&
    STATUSES.includes(item.status) &&
    isSize(item.width) &&
    isSize(item.height)
  )
}

export async function readItems($: StateDollar): Promise<PreviewItem[]> {
  const { value } = await $.state.get({ plugin: 'image-handler', key: 'items' })
  if (!Array.isArray(value) || !value.every(isItem)) return []
  return value
}

export async function writeItems($: StateDollar, items: PreviewItem[]): Promise<void> {
  const stored = await readItems($)
  if (JSON.stringify(stored) === JSON.stringify(items)) return
  await $.state.set({ plugin: 'image-handler', key: 'items' }, items)
}

export async function readOffer($: StateDollar): Promise<ClipboardOffer | null> {
  const { value } = await $.state.get({ plugin: 'image-handler', key: 'clipboard' })
  if (typeof value !== 'object' || value === null) return null
  const offer = value as Record<string, unknown>
  if (!STATUSES.includes(offer.status) || !isSize(offer.width) || !isSize(offer.height)) return null
  return { status: offer.status as ClipboardOffer['status'], width: offer.width, height: offer.height }
}

export async function writeOffer($: StateDollar, offer: ClipboardOffer | null): Promise<void> {
  const stored = await readOffer($)
  if (JSON.stringify(stored) === JSON.stringify(offer)) return
  await $.state.set({ plugin: 'image-handler', key: 'clipboard' }, offer)
}
