import type { Tool } from "./tool"

export namespace Orchestration {
  interface Safety {
    concurrency?: boolean
    readonly?: boolean
    destructive?: boolean
  }

  const MAX = 10
  const registry = new Map<string, Safety>()

  export function register(defs: Tool.Def[]) {
    registry.clear()
    for (const def of defs) {
      registry.set(def.id, {
        concurrency: def.concurrency,
        readonly: def.readonly,
        destructive: def.destructive,
      })
    }
  }

  function lock() {
    let readers = 0
    let writer = false
    const queue: Array<() => void> = []

    function drain() {
      if (queue.length === 0) return
      if (writer) return
      // try to admit the next waiter
      const next = queue[0]
      // peek at whether it's a read or write (tagged below)
      if ((next as unknown as { _write?: boolean })._write) {
        if (readers === 0) {
          queue.shift()!()
        }
        return
      }
      // admit all consecutive readers up to MAX
      while (queue.length > 0 && !(queue[0] as unknown as { _write?: boolean })._write && readers < MAX) {
        readers++
        queue.shift()!()
      }
    }

    return {
      read(): Promise<() => void> {
        if (!writer && readers < MAX && queue.length === 0) {
          readers++
          return Promise.resolve(() => {
            readers--
            drain()
          })
        }
        return new Promise<() => void>((resolve) => {
          queue.push(() =>
            resolve(() => {
              readers--
              drain()
            }),
          )
          drain()
        })
      },
      write(): Promise<() => void> {
        if (!writer && readers === 0 && queue.length === 0) {
          writer = true
          return Promise.resolve(() => {
            writer = false
            drain()
          })
        }
        return new Promise<() => void>((resolve) => {
          const fn = () => {
            writer = true
            resolve(() => {
              writer = false
              drain()
            })
          }
          ;(fn as unknown as { _write?: boolean })._write = true
          queue.push(fn)
        })
      },
    }
  }

  /**
   * Wraps AI SDK tool execute functions with read/write lock concurrency control.
   * Concurrent-safe tools acquire a shared read lock; others acquire an exclusive write lock.
   *
   * The `tools` parameter uses `Record<string, any>` because the AI SDK `Tool` type
   * is deeply generic and its execute signature varies by tool. We only touch the
   * `execute` property and preserve all other fields as-is.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function wrap(tools: Record<string, any>): Record<string, any> {
    const rw = lock()
    const result = { ...tools }
    for (const [id, original] of Object.entries(result)) {
      if (!original?.execute) continue
      const exec = original.execute
      const safety = registry.get(id)
      if (safety?.concurrency) {
        result[id] = {
          ...original,
          execute: async (...args: unknown[]) => {
            const unlock = await rw.read()
            try {
              return await exec(...args)
            } finally {
              unlock()
            }
          },
        }
      } else {
        result[id] = {
          ...original,
          execute: async (...args: unknown[]) => {
            const unlock = await rw.write()
            try {
              return await exec(...args)
            } finally {
              unlock()
            }
          },
        }
      }
    }
    return result
  }
}
