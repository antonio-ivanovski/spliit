/** Keep bulk inserts below PostgreSQL's practical parameter limit. */
export const IMPORT_BATCH_SIZE = 1000

export async function createManyInBatches<T>(
  rows: readonly T[],
  createMany: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += IMPORT_BATCH_SIZE) {
    await createMany(rows.slice(offset, offset + IMPORT_BATCH_SIZE))
  }
}
