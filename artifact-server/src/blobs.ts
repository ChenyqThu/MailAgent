import { ArtifactServerError, type Env } from './types'

export interface BlobRecord {
  body: ReadableStream
  contentType?: string
}

interface KvBlobMetadata {
  contentType?: string
}

export async function putBlob(
  env: Env,
  key: string,
  bytes: Uint8Array,
  contentType: string
): Promise<void> {
  if (env.BUCKET) {
    await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType }
    })
    return
  }
  if (env.ARTIFACTS_KV) {
    const ownedBuffer = new Uint8Array(bytes).buffer
    await env.ARTIFACTS_KV.put(key, ownedBuffer, {
      metadata: { contentType }
    })
    return
  }
  throw new ArtifactServerError('E_CONFIG', 'Neither BUCKET nor ARTIFACTS_KV is bound', 500)
}

export async function getBlob(env: Env, key: string): Promise<BlobRecord | null> {
  if (env.BUCKET) {
    const object = await env.BUCKET.get(key)
    if (!object) return null
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType
    }
  }
  if (env.ARTIFACTS_KV) {
    const res = await env.ARTIFACTS_KV.getWithMetadata<KvBlobMetadata>(key, 'stream')
    if (!res.value) return null
    return {
      body: res.value,
      contentType: res.metadata?.contentType
    }
  }
  throw new ArtifactServerError('E_CONFIG', 'Neither BUCKET nor ARTIFACTS_KV is bound', 500)
}

export async function deleteBlobPrefix(env: Env, prefix: string): Promise<number> {
  if (env.BUCKET) {
    let removed = 0
    let cursor: string | undefined
    do {
      const page = await env.BUCKET.list({
        prefix,
        limit: 500,
        ...(cursor ? { cursor } : {})
      })
      const keys = page.objects.map((o) => o.key)
      if (keys.length > 0) {
        await env.BUCKET.delete(keys)
        removed += keys.length
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return removed
  }

  if (env.ARTIFACTS_KV) {
    let removed = 0
    let cursor: string | undefined
    do {
      const page = await env.ARTIFACTS_KV.list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {})
      })
      const names = page.keys.map((k) => k.name)
      for (let i = 0; i < names.length; i += 20) {
        await Promise.all(names.slice(i, i + 20).map((name) => env.ARTIFACTS_KV!.delete(name)))
      }
      removed += names.length
      cursor = !page.list_complete ? page.cursor : undefined
    } while (cursor)
    return removed
  }

  throw new ArtifactServerError('E_CONFIG', 'Neither BUCKET nor ARTIFACTS_KV is bound', 500)
}
