import * as vscode from "vscode"
import { spawn } from "child_process"
import { emptyUri } from "./uris"
import { getQueryConfig } from "./configuration"

export type RawListResponseDatum = {
  name: string
  expiration?: number
  metadata?: any
}

export type ListResponseDatum = {
  key: string
  expiration?: number
  metadata?: any
}

const wranglerChannel = vscode.window.createOutputChannel("Cloudflare Wrangler")
const wrangle = (namespaceID: string, args: string[]): Promise<Buffer> =>
  new Promise((c, e) => {
    const task = [
      "wrangler",
      ["--namespace-id", namespaceID, "kv:key", ...args],
    ] as const
    const taskLabel = JSON.stringify(task[0] + " " + task[1].join(" "))
    const spawned = spawn(...task)
    wranglerChannel.appendLine(
      new Date().toLocaleString() + " " + "Spawn " + taskLabel,
    )

    const stdout: Buffer[] = []
    spawned.stdout.on("data", (data: Buffer) => stdout.push(data))

    const stderr: Buffer[] = []
    spawned.stderr.on("data", (data: Buffer) => stderr.push(data))

    spawned.on("close", () => {
      const allStdout = Buffer.concat(stdout)
      const allStderr = Buffer.concat(stderr)

      const allStdoutStr = JSON.stringify(allStdout.toString())
      const allStderrStr = JSON.stringify(allStderr.toString())
      wranglerChannel.append(
        new Date().toLocaleString() +
          " " +
          `Ended ${taskLabel}\nstdout: ${allStdoutStr}\nstderr: ${allStderrStr}\n`,
      )

      return stderr.length ? e(allStderr.toString()) : c(allStdout)
    })
  })

const metadataCache = new Map<string, string>()
const expirationCache = new Map<string, number | undefined>()
const listCache = new Map<
  string,
  { onChange?: () => void; data: ListResponseDatum[] }
>()

export const list = async (
  opts: {
    namespaceID: string
    prefix: string
  },
  onListModified?: () => void,
): Promise<ListResponseDatum[]> => {
  const listCacheKey = opts.namespaceID + "/" + opts.prefix
  if (listCache.has(listCacheKey)) {
    const list = listCache.get(listCacheKey)!.data.map((datum) => {
      const datumCacheKey = opts.namespaceID + "/" + datum.key
      const expiration = expirationCache.get(datumCacheKey)
      datum.expiration = expiration
      const metadata = metadataCache.get(datumCacheKey)
      if (metadata) {
        try {
          datum.metadata = JSON.parse(metadata)
        } catch (e) {
          console.error("error parsing element metadata", e, metadata)
        }
      } else {
        datum.metadata = undefined
      }

      return datum
    })
    console.log("got list from cache", list)
    listCache.set(listCacheKey, { data: list, onChange: onListModified })
    return list
  }

  const buffer = await wrangle(opts.namespaceID, [
    "list",
    ...(opts.prefix ? ["--prefix", opts.prefix] : []),
  ])
  const list = buffer.toString()
  try {
    const rawData = JSON.parse(list) as RawListResponseDatum[]
    const data: ListResponseDatum[] = []
    for (const datum of rawData) {
      metadataCache.set(
        opts.namespaceID + "/" + datum.name,
        JSON.stringify(datum.metadata),
      )
      expirationCache.set(opts.namespaceID + "/" + datum.name, datum.expiration)
      data.push({
        key: datum.name,
        expiration: datum.expiration,
        metadata: datum.metadata,
      })
    }
    listCache.set(listCacheKey, { data, onChange: onListModified })
    return data
  } catch (e) {
    throw Error(
      `Unable to parse list response: ${list.toString()} (Error: ${e})`,
    )
  }
}

const contentsCache = new Map<string, Promise<Uint8Array>>()
const cacheContents = (key: string, value: Promise<Uint8Array>) => {
  contentsCache.set(key, value)
  setTimeout(() => {
    if (contentsCache.get(key) === value) {
      contentsCache.delete(key)
    }
  }, 60 * 1000)
}

export const get = async (opts: {
  namespaceID: string
  key: string
}): Promise<Uint8Array> => {
  const cacheKey = opts.namespaceID + "/" + opts.key
  if (!contentsCache.has(cacheKey)) {
    cacheContents(cacheKey, wrangle(opts.namespaceID, ["get", opts.key]))
  }
  return contentsCache.get(cacheKey)!
}

export const setMetadata = async (opts: {
  namespaceID: string
  key: string
  meta: string
}) => {
  metadataCache.set(opts.namespaceID + "/" + opts.key, opts.meta)
  await put({
    key: opts.key,
    namespaceID: opts.namespaceID,
    value: await get(opts),
  })
}

export const setExpiration = async (opts: {
  namespaceID: string
  key: string
  expiration?: number
}) => {
  expirationCache.set(opts.namespaceID + "/" + opts.key, opts.expiration)
  await put({
    key: opts.key,
    namespaceID: opts.namespaceID,
    value: await get(opts),
  })
}

export const put = async (opts: {
  namespaceID: string
  key: string
  value: Uint8Array
}) => {
  const cacheKey = opts.namespaceID + "/" + opts.key

  if (!(metadataCache.has(cacheKey) && expirationCache.has(cacheKey))) {
    console.log(
      "metadata/expiry not in cache, fetching via a list operation",
      cacheKey,
    )
    await list({ namespaceID: opts.namespaceID, prefix: opts.key })
    if (!(metadataCache.has(cacheKey) && expirationCache.has(cacheKey))) {
      throw Error("could not find value in cache: " + cacheKey)
    }
  }

  const metadata = metadataCache.get(cacheKey)
  const expiration = expirationCache.get(cacheKey)

  return putFull({ ...opts, metadata, expiration })
}

export const putFull = async (opts: {
  namespaceID: string
  key: string
  value: Uint8Array
  metadata?: string
  expiration?: number
}) => {
  await wrangle(opts.namespaceID, [
    "put",
    opts.key,
    ...(opts.value.length
      ? [opts.value.toString()]
      : ["--path", (await emptyUri).fsPath]),
    ...(opts.metadata ? ["--metadata", opts.metadata] : []),
    ...(opts.expiration ? ["--expiration", String(opts.expiration)] : []),
  ])
  const cacheKey = opts.namespaceID + "/" + opts.key
  cacheContents(cacheKey, Promise.resolve(opts.value))
  metadataCache.set(cacheKey, opts.metadata ?? "")
  expirationCache.set(cacheKey, opts.expiration)

  const affectedQueries = getQueryConfig().filter(
    ({ namespaceID, prefix }) =>
      namespaceID === opts.namespaceID && opts.key.startsWith(prefix || ""),
  )

  affectedQueries.forEach((q) => {
    const cacheKey = q.namespaceID + "/" + (q.prefix ?? "")
    const cached = listCache.get(cacheKey)
    if (cached) {
      const insertIndex = cached.data.findIndex((v) => v.key >= opts.key)

      const datum: ListResponseDatum = {
        key: opts.key,
        expiration: opts.expiration,
        metadata: opts.metadata,
      }

      if (insertIndex === -1) {
        cached.data.push(datum)
      } else if (cached.data[insertIndex].key === opts.key) {
        cached.data[insertIndex] = datum
      } else {
        cached.data.splice(insertIndex, 0, datum)
      }
      cached.onChange?.()
    }
  })
}

export const del = async (opts: {
  namespaceID: string
  key: string
  prefix: string
}) => {
  const cachedList = listCache.get(opts.namespaceID + "/" + opts.prefix)
  if (!cachedList) {
    throw Error(
      "Cannot find parent list for delete element: " + JSON.stringify(opts),
    )
  }
  const index = cachedList.data.findIndex((v) => v.key === opts.key)
  if (index === -1) {
    throw Error(
      "Cannot find delete element in parent list: " +
        JSON.stringify({ deleteElement: opts, parentList: cachedList }),
    )
  }
  cachedList.data.splice(index, 1)
  cachedList.onChange?.()
  clearEntryCache({ namespaceID: opts.namespaceID, key: opts.key })

  await wrangle(opts.namespaceID, ["delete", opts.key])
}

export const clearEntryCache = (opts?: {
  namespaceID: string
  key: string
}) => {
  if (!opts) {
    metadataCache.clear()
    expirationCache.clear()
    contentsCache.clear()
  } else {
    const cacheKey = opts.namespaceID + "/" + opts.key
    metadataCache.delete(cacheKey)
    expirationCache.delete(cacheKey)
    contentsCache.delete(cacheKey)
  }
}

export const clearListCache = (opts?: {
  namespaceID: string
  prefix: string
}) => {
  if (!opts) {
    listCache.clear()
  } else {
    listCache.delete(opts.namespaceID + "/" + opts.prefix)
  }
}
