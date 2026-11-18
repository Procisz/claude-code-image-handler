export type PreviewItem = {
  id: string
  kind: 'tag' | 'path'
  label: string
  status: 'loading' | 'ready' | 'failed'
  width: number
  height: number
}

export type ClipboardOffer = {
  status: 'loading' | 'ready' | 'failed'
  width: number
  height: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-handler': { items: PreviewItem[]; clipboard: ClipboardOffer | null }
  }
}
