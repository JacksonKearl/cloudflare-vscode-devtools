import * as vscode from "vscode"
import { kvFileSystemProvider } from "./kvFileSystemProvider"
import {
  KVTreeElement,
  KVQueryElement,
  kvTreeDataProvider,
  KVEntryElement,
} from "./kvTreeDataProvider"
import { kvForUri, kvScheme, uriForKV } from "./uris"
import {
  clearEntryCache,
  clearListCache,
  del,
  setExpiration,
  setMetadata,
} from "./wrangler"

export function activate(context: vscode.ExtensionContext) {
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
      "cloudflare-devtools.deleteEntry",
      async (entry: KVEntryElement, other?: KVTreeElement[]) => {
        vscode.window.withProgress(
          { location: { viewId: "cloudflare-devtools.kv" } },
          () =>
            Promise.all(
              (other ?? [entry]).map(async (entry) => {
                if (entry.type === "entry") {
                  const task = del({
                    key: entry.name,
                    namespaceID: entry.namespaceID,
                    prefix: entry.parent.prefix,
                  })
                  // instantly trigger the update so the layout shift happens ASAP, less likely to mis-click later
                  treeChangeEmitter.fire(entry.parent)
                  // await here so progress is shown until delete has finished
                  await task
                  fsChangeEmitter.fire([
                    {
                      type: vscode.FileChangeType.Deleted,
                      uri: uriForKV({
                        namespaceID: entry.namespaceID,
                        key: entry.name,
                      }),
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
        const entry = { namespaceID: element.namespaceID, key: element.name }
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
          () => setMetadata({ ...entry, meta: update }),
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
        const entry = { namespaceID: element.namespaceID, key: element.name }
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
          () => setExpiration({ ...entry, expiration: newExpiration }),
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

  const kvTreeView = vscode.window.createTreeView("cloudflare-devtools.kv", {
    treeDataProvider: kvTreeDataProvider(treeChangeEmitter),
    canSelectMany: true,
    showCollapseAll: true,
  })

  context.subscriptions.push(kvTreeView)
}

export function deactivate() {}
