type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] }

function flatten(children: unknown[]): unknown[] {
  return children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
}

function Fragment(props: { children?: unknown[] }): Node {
  return { type: 'Fragment', props: {}, children: flatten(props.children ?? []) }
}

function h(type: unknown, props: Record<string, unknown> | null | undefined, ...children: unknown[]): Node {
  return { type, props: { ...(props ?? {}) }, children: flatten(children) }
}

Object.assign(globalThis, { h, Fragment })
