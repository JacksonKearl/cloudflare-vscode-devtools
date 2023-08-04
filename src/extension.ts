import * as vscode from "vscode"
import { kvFileSystemProvider } from "./kvFileSystemProvider"
import {
  KVTreeElement,
  KVQueryElement,
  kvTreeDataProvider,
  KVEntryElement,
  KVMetaElement,
} from "./kvTreeDataProvider"
import { kvForUri, kvScheme, makeEmptyFile, uriForKV } from "./uris"
import {
  clearEntryCache,
  clearListCache,
  del,
  get,
  putFull,
  setExpiration,
  setMetadata,
} from "./wrangler"

export function activate(context: vscode.ExtensionContext) {
  makeEmptyFile(context.globalStorageUri)

  const treeChangeEmitter = new vscode.EventEmitter<
    void | KVTreeElement | KVTreeElement[]
  >()
  const fsChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  context.subscriptions.push(treeChangeEmitter)

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cloudflare-devtools.kv")) {
        treeChangeEmitter.fire()
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.refreshQuery",
      (query: KVQueryElement) => {
        clearEntryCache()
        clearListCache({ namespaceID: query.namespaceID, prefix: query.prefix })
        treeChangeEmitter.fire(query)
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.createEntry",
      async (query: KVQueryElement) => {
        const key = await vscode.window.showInputBox({
          title: "Enter Key",
          value: query.prefix,
        })

        if (!key) {
          return
        }

        vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          async () => {
            const entry = {
              namespaceID: query.namespaceID,
              key,
              value: new Uint8Array(),
            }
            await putFull(entry)
            await vscode.commands.executeCommand("vscode.open", uriForKV(entry))
          },
        )
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.editKey",
      async (entry: KVEntryElement) => {
        const newKey = await vscode.window.showInputBox({
          value: entry.key,
          title: "Enter new Key",
        })
        if (!newKey) {
          return
        }
        vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          async () => {
            const value = await get(entry)

            await putFull({
              namespaceID: entry.namespaceID,
              key: newKey,
              value,
              expiration: entry.expiration,
              metadata: JSON.stringify(entry.metadata),
            })

            await del({
              ...entry,
              prefix: entry.parent.prefix,
            })
          },
        )
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.expandAllMetadata",
      (e: KVQueryElement) => {
        kvTreeView.reveal(e, { expand: 3 })
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.deleteEntry",
      async (entry: KVEntryElement, other?: KVTreeElement[]) => {
        vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          () =>
            Promise.all(
              (other ?? [entry]).map(async (entry) => {
                if (entry.type === "entry") {
                  await del({
                    ...entry,
                    prefix: entry.parent.prefix,
                  })
                  fsChangeEmitter.fire([
                    {
                      type: vscode.FileChangeType.Deleted,
                      uri: uriForKV(entry),
                    },
                  ])
                }
              }),
            ),
        )
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.refreshEntry",
      (uri: vscode.Uri) => {
        clearEntryCache(kvForUri(uri))
        fsChangeEmitter.fire([{ uri, type: vscode.FileChangeType.Changed }])
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.editMetadata",
      async (element: KVEntryElement) => {
        const update = await vscode.window.showInputBox({
          value: JSON.stringify(element.metadata),
          validateInput(value) {
            if (value === "") return null
            try {
              JSON.parse(value)
              return null
            } catch {
              return "Metadata must be valid JSON"
            }
          },
        })

        if (update === undefined) {
          return
        }

        await vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          () => setMetadata({ ...element, meta: update }),
        )
        treeChangeEmitter.fire(element.parent)
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.editExpiration",
      async (element: KVEntryElement) => {
        const prior = element.expiration
          ? new Date(element.expiration * 1000).toISOString()
          : ""

        const ex = new Date().toISOString()
        const update = await vscode.window.showInputBox({
          value: prior,
          title: "Set Expiration Date",
          prompt: `Enter as ISO formatted string (i.e. ${ex})`,
          validateInput(value) {
            if (value === "") return null

            try {
              const d = new Date(value)
              if (isNaN(+d)) {
                return `Must enter a valid ISO date string (i.e. ${ex})`
              }
              if (+d < Date.now()) {
                return "Must enter a future date"
              }
            } catch {
              return `Must enter a valid ISO date string (i.e. ${ex})`
            }
            return null
          },
        })

        if (update === undefined) {
          return
        }

        const newExpiration =
          update === "" ? undefined : +new Date(update) / 1000

        await vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          () => setExpiration({ ...element, expiration: newExpiration }),
        )
        treeChangeEmitter.fire(element.parent)
      },
    ),
  )

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      kvScheme,
      kvFileSystemProvider(fsChangeEmitter),
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.copyKey",
      (item: KVEntryElement, rest: KVTreeElement[]) => {
        const toCopy: KVEntryElement[] = rest
          ? rest.filter((r): r is KVEntryElement => r.type === "entry")
          : [item]
        const keys = toCopy.map((e) => e.key)
        if (keys.length === 1) {
          return vscode.env.clipboard.writeText(keys[0])
        } else {
          return vscode.env.clipboard.writeText(JSON.stringify(keys))
        }
      },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cloudflare-devtools.copyMetadata",
      (
        item: KVEntryElement | KVMetaElement,
        rest: (KVEntryElement | KVMetaElement)[],
      ) => {
        const getMetaData = (element: KVEntryElement | KVMetaElement) => {
          if (element.type === "entry") {
            return element.metadata
          } else {
            return element.value
          }
        }
        if (rest) {
          const entriesCopied = new Set<KVTreeElement>()
          vscode.env.clipboard.writeText(
            JSON.stringify(
              rest
                .map((r) => {
                  if (r.type === "entry") {
                    entriesCopied.add(r)
                  } else {
                    let parent = r.parent
                    while (r.parent.type !== "entry") {
                      parent = r.parent
                    }
                    if (entriesCopied.has(parent)) {
                      return undefined
                    }
                  }
                  return getMetaData(r)
                })
                .filter((x) => x !== undefined),
            ),
          )
        } else {
          vscode.env.clipboard.writeText(
            JSON.stringify(getMetaData(item)) ?? "[Empty Metadata]",
          )
        }
      },
    ),
  )

  const kvTreeView = vscode.window.createTreeView("cloudflare-devtools.kv", {
    treeDataProvider: kvTreeDataProvider(treeChangeEmitter),
    canSelectMany: true,
    showCollapseAll: true,
  })

  context.subscriptions.push(kvTreeView)
}

export function deactivate() {}
