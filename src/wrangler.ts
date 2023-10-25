import * as vscode from "vscode"
import { spawn } from "child_process"
import { emptyUri } from "./uris"
import {
  NamespaceConfig,
  getQueriesConfig,
  getWranglerPathConfig,
} from "./configuration"

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

const namespacesEqual = (a: NamespaceConfig, b: NamespaceConfig): boolean => {
  if (a.id !== b.id) {
    return false
  }
  if (a.binding !== b.binding) {
    return false
  }
  if (a.local !== b.local) {
    return false
  }
  if (a.preview !== b.preview) {
    return false
  }

  return true
}

const getCacheKey = (namespace: NamespaceConfig, rest: string): string => {
  if ("id" in namespace) {
    return `${namespace.basePath}/${namespace.id}/${namespace.local ? "local" : "remote"
      }/${rest}`
  } else {
    return `${namespace.basePath}/${namespace.binding}/${namespace.local ? "local" : "remote"
      }/${namespace.preview ? "preview" : "production"}/${rest}`
  }
}

const wranglerChannel = vscode.window.createOutputChannel("Cloudflare Wrangler")
const wrangle = (namespace: NamespaceConfig, args: string[]): Promise<Buffer> =>
  new Promise((c, e) => {
    const cmd = getWranglerPathConfig()
    const bin = cmd.split(" ", 1)[0]
    const rest = cmd.slice(bin.length + 1)

    const namespaceArgs = []
    if (namespace.binding) {
      namespaceArgs.push("--binding", namespace.binding)
    }
    if (namespace.id) {
      namespaceArgs.push("--namespace-id", namespace.id)
    }
    if (
      namespace.preview ||
      (namespace.local && namespace.preview === undefined)
    ) {
      namespaceArgs.push("--preview")
    } else {
      namespaceArgs.push("--preview")
      namespaceArgs.push("false")
    }
    if (namespace.local) {
      namespaceArgs.push("--local")
    }

    const cwd =
      namespace.basePath || vscode.workspace.workspaceFolders?.[0].uri.fsPath

    const task = [
      bin,
      [
        ...(rest ? [rest] : []),
        ...(cmd === "npx" ? ["--yes"] : []),
        "kv:key",
        ...args,
        ...namespaceArgs,
      ],
    ] as const

    const taskLabel =
      JSON.stringify(task[0] + " " + task[1].join(" ")) + " at " + cwd

    const spawned = spawn(...task, { cwd })
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

      return c(allStdout)
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
    namespace: NamespaceConfig
    prefix: string
  },
  onListModified?: () => void,
): Promise<ListResponseDatum[]> => {
  const listCacheKey = getCacheKey(opts.namespace, opts.prefix)
  if (listCache.has(listCacheKey)) {
    const list = listCache.get(listCacheKey)!.data.map((datum) => {
      const datumCacheKey = getCacheKey(opts.namespace, datum.key)
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

  const buffer = await wrangle(opts.namespace, [
    "list",
    ...(opts.prefix ? ["--prefix", opts.prefix] : []),
  ])
  const list = buffer.toString()
  try {
    let rawData = JSON.parse(list) as
      | RawListResponseDatum[]
      | { keys: RawListResponseDatum[] }

    const data: ListResponseDatum[] = []
    for (const datum of Array.isArray(rawData) ? rawData : rawData.keys) {
      if (!datum.name.startsWith(opts.prefix)) {
        console.error("List error: invalid prefix matching", { opts, datum })
        continue
      }
      metadataCache.set(
        getCacheKey(opts.namespace, datum.name),
        JSON.stringify(datum.metadata),
      )
      expirationCache.set(
        getCacheKey(opts.namespace, datum.name),
        datum.expiration,
      )
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
  namespace: NamespaceConfig
  key: string
}): Promise<Uint8Array> => {
  const cacheKey = getCacheKey(opts.namespace, opts.key)

  if (!contentsCache.has(cacheKey)) {
    cacheContents(cacheKey, wrangle(opts.namespace, ["get", opts.key]))
  }
  return contentsCache.get(cacheKey)!
}

export const setMetadata = async (opts: {
  namespace: NamespaceConfig
  key: string
  meta: string
}) => {
  metadataCache.set(getCacheKey(opts.namespace, opts.key), opts.meta)
  await put({
    key: opts.key,
    namespace: opts.namespace,
    value: await get(opts),
  })
}

export const setExpiration = async (opts: {
  namespace: NamespaceConfig
  key: string
  expiration?: number
}) => {
  expirationCache.set(getCacheKey(opts.namespace, opts.key), opts.expiration)
  await put({
    key: opts.key,
    namespace: opts.namespace,
    value: await get(opts),
  })
}

export const put = async (opts: {
  namespace: NamespaceConfig
  key: string
  value: Uint8Array
}) => {
  const cacheKey = getCacheKey(opts.namespace, opts.key)

  if (!(metadataCache.has(cacheKey) && expirationCache.has(cacheKey))) {
    console.log(
      "metadata/expiry not in cache, fetching via a list operation",
      cacheKey,
    )
    await list({ namespace: opts.namespace, prefix: opts.key })
    if (!(metadataCache.has(cacheKey) && expirationCache.has(cacheKey))) {
      const whatToDo = await vscode.window.showErrorMessage(
        `Could not determine expiration or metadata for key ${opts.key}, has the entry been deleted?`,
        { modal: true },
        "Cancel",
        "Create New",
      )
      if (whatToDo === "Cancel") {
        throw Error("Cancelled")
      }

      console.warn(
        "could not find value in cache: " + cacheKey,
        "using empty values",
      )
    }
  }

  const metadata = metadataCache.get(cacheKey)
  const expiration = expirationCache.get(cacheKey)

  return putFull({ ...opts, metadata, expiration })
}

export const putFull = async (opts: {
  namespace: NamespaceConfig
  key: string
  value: Uint8Array
  metadata?: string
  expiration?: number
}) => {
  await wrangle(opts.namespace, [
    "put",
    opts.key,
    ...(opts.value.length
      ? [opts.value.toString()]
      : ["--path", (await emptyUri).fsPath]),
    ...(opts.metadata ? ["--metadata", opts.metadata] : []),
    ...(opts.expiration ? ["--expiration", String(opts.expiration)] : []),
  ])
  const cacheKey = getCacheKey(opts.namespace, opts.key)
  cacheContents(cacheKey, Promise.resolve(opts.value))
  metadataCache.set(cacheKey, opts.metadata ?? "")
  expirationCache.set(cacheKey, opts.expiration)

  const affectedQueries = (await getQueriesConfig()).filter(
    ({ namespace, prefix }) =>
      namespacesEqual(namespace, opts.namespace) &&
      opts.key.startsWith(prefix || ""),
  )

  affectedQueries.forEach((q) => {
    const cacheKey = getCacheKey(q.namespace, q.prefix ?? "")
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
  namespace: NamespaceConfig
  key: string
  prefix: string
}) => {
  const cachedList = listCache.get(getCacheKey(opts.namespace, opts.prefix))
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
  clearEntryCache({ namespace: opts.namespace, key: opts.key })

  await wrangle(opts.namespace, ["delete", opts.key])

  const affectedQueries = (await getQueriesConfig()).filter(
    ({ namespace, prefix }) =>
      namespacesEqual(namespace, opts.namespace) &&
      opts.key.startsWith(prefix || ""),
  )

  affectedQueries.forEach((q) => {
    const cacheKey = getCacheKey(q.namespace, q.prefix ?? "")
    const cached = listCache.get(cacheKey)
    if (cached) {
      const insertIndex = cached.data.findIndex((v) => v.key === opts.key)
      if (insertIndex !== -1) {
        cached.data.splice(insertIndex, 1)
      }
      cached.onChange?.()
    }
  })
}

export const clearEntryCache = (opts?: {
  namespace: NamespaceConfig
  key: string
}) => {
  if (!opts) {
    metadataCache.clear()
    expirationCache.clear()
    contentsCache.clear()
  } else {
    const cacheKey = getCacheKey(opts.namespace, opts.key)
    metadataCache.delete(cacheKey)
    expirationCache.delete(cacheKey)
    contentsCache.delete(cacheKey)
  }
}

export const clearListCache = (opts?: {
  namespace: NamespaceConfig
  prefix: string
}) => {
  if (!opts) {
    listCache.clear()
  } else {
    listCache.delete(getCacheKey(opts.namespace, opts.prefix))
  }
}
