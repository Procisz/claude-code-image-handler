const WINDOW_MS = 2000

type Entry = { paths: string[]; at: number }

export type PasteMemory = {
  record(paths: string[], at: number): void
  claim(newTags: number[], at: number): Map<number, string>
}

export function createPasteMemory(): PasteMemory {
  let records: Entry[] = []

  const prune = (at: number) => {
    records = records.filter((entry) => at - entry.at <= WINDOW_MS)
  }

  return {
    record(paths, at) {
      prune(at)
      records.push({ paths: [...paths], at })
    },
    claim(newTags, at) {
      prune(at)
      const queue = records.flatMap((entry) => entry.paths)
      const claimed = new Map<number, string>()
      for (const tag of newTags) {
        const path = queue.shift()
        if (path === undefined) break
        claimed.set(tag, path)
      }
      let left = claimed.size
      records = records
        .map((entry) => {
          const used = Math.min(left, entry.paths.length)
          left -= used
          return { paths: entry.paths.slice(used), at: entry.at }
        })
        .filter((entry) => entry.paths.length > 0)
      return claimed
    },
  }
}
