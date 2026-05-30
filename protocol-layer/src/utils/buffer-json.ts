function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
}

function isBufferJson(value: Record<string, unknown>): boolean {
  return value.type === 'Buffer' && ('data' in value)
}

export function reviveJsonBuffers<T>(value: T): T {
  if (Buffer.isBuffer(value)) return value

  if (Array.isArray(value)) {
    return value.map(item => reviveJsonBuffers(item)) as T
  }

  if (!isPlainObject(value)) return value

  if (isBufferJson(value)) {
    const data = value.data
    if (Array.isArray(data)) return Buffer.from(data as number[]) as T
    if (typeof data === 'string') return Buffer.from(data, 'base64') as T
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = reviveJsonBuffers(item)
  }
  return out as T
}
