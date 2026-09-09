/**
 * Shared async-concurrency primitive. Lives here (not in `currency-rates.ts`,
 * where it was born) because both the FX batcher and the file-import document
 * lifecycle bound unrelated fan-outs with it: one semaphore, two owners.
 */
/** Inline semaphore: run `fn` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[]
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = next
        next += 1
        if (index >= items.length) break
        results[index] = await fn(items[index]!)
      }
    },
  )
  await Promise.all(workers)
  return results
}
