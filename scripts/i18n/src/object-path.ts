export type Path = string | readonly string[]

function parsePath(path: Path): string[] {
  if (typeof path === 'string')
    return path.split('.').filter((s) => s.length > 0)
  return [...path]
}

export function getAt(obj: unknown, path: Path): unknown {
  const segments = parsePath(path)
  let current: unknown = obj
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[seg]
  }
  return current
}

export function setAt(
  obj: Record<string, unknown>,
  path: Path,
  value: unknown,
): void {
  const segments = parsePath(path)
  if (segments.length === 0) {
    throw new Error('setAt: empty path')
  }
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = current[seg]
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      current[seg] = {}
    }
    current = current[seg] as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}

export function removeAt(obj: Record<string, unknown>, path: Path): boolean {
  const segments = parsePath(path)
  if (segments.length === 0) return false
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = current[seg]
    if (next == null || typeof next !== 'object') return false
    current = next as Record<string, unknown>
  }
  const last = segments[segments.length - 1]
  if (!(last in current)) return false
  delete current[last]
  return true
}

export function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return []
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, path))
    } else {
      keys.push(path)
    }
  }
  return keys
}

export function reorderSiblings(
  parent: Record<string, unknown>,
  reference: Record<string, unknown>,
  key: string,
): void {
  if (!(key in parent)) return
  const refKeys = Object.keys(reference)
  const refIndex = refKeys.indexOf(key)
  if (refIndex === -1) return

  let insertBefore: string | null = null
  for (let i = refIndex + 1; i < refKeys.length; i++) {
    if (refKeys[i] in parent) {
      insertBefore = refKeys[i]
      break
    }
  }

  const value = parent[key]
  const rebuilt: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parent)) {
    if (k === key) continue
    if (k === insertBefore) rebuilt[key] = value
    rebuilt[k] = v
  }
  if (insertBefore === null) rebuilt[key] = value

  for (const k of Object.keys(parent)) delete parent[k]
  Object.assign(parent, rebuilt)
}

export function setAtOrdered(
  obj: Record<string, unknown>,
  path: Path,
  value: unknown,
  reference: Record<string, unknown>,
): void {
  setAt(obj, path, value)
  const segments = parsePath(path)
  if (segments.length === 0) return
  const lastKey = segments[segments.length - 1]
  const parentPath = segments.slice(0, -1)
  const parent =
    parentPath.length === 0
      ? obj
      : (getAt(obj, parentPath) as Record<string, unknown>)
  const refParent =
    parentPath.length === 0
      ? reference
      : (getAt(reference, parentPath) as Record<string, unknown> | null)
  if (parent != null && refParent != null && typeof refParent === 'object') {
    reorderSiblings(parent, refParent, lastKey)
  }
}

export function cleanupEmptyParents(
  obj: Record<string, unknown>,
  path: Path,
): void {
  const segments = parsePath(path)
  let depth = segments.length - 1
  while (depth >= 1) {
    const parentPath = segments.slice(0, depth)
    const parent = parentPath.length === 0 ? obj : getAt(obj, parentPath)
    if (
      parent != null &&
      typeof parent === 'object' &&
      !Array.isArray(parent) &&
      Object.keys(parent as Record<string, unknown>).length === 0
    ) {
      const key = segments[depth - 1]
      const grandparentPath = segments.slice(0, depth - 1)
      const grandparent =
        grandparentPath.length === 0
          ? obj
          : (getAt(obj, grandparentPath) as Record<string, unknown>)
      delete grandparent[key]
      depth--
    } else {
      break
    }
  }
}
