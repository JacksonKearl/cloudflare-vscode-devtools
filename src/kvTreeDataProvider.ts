import * as vscode from "vscode"
import { ListResponseDatum, list } from "./wrangler"
import { uriForKV } from "./uris"

const trySimpleStringRep = (value: any): string | undefined => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "object" && Object.entries(value).length === 0)
  ) {
    return JSON.stringify(value)
  }
  return undefined
}

const getMetadataChildren = (metadata: any): KVMetaElement[] => {
  if (metadata === undefined) {
    return []
  }
  const str = trySimpleStringRep(metadata)
  if (str) {
    return [{ type: "meta", key: str, singleChild: true }]
  } else {
    const entries = Object.entries(metadata)
    return entries.map(([key, value]) => ({
      type: "meta",
      key,
      value,
      singleChild: entries.length === 1,
    }))
  }
}

export type KVQueryElement = {
  type: "query"
  namespaceID: string
  prefix: string
  title: string
}

export type KVEntryElement = {
  type: "entry"
  namespaceID: string
  parent: KVQueryElement
} & ListResponseDatum

type KVMetaElement = {
  type: "meta"
  key: string
  value?: any
  singleChild: boolean
}
export type KVTreeElement = KVQueryElement | KVEntryElement | KVMetaElement

export const kvTreeDataProvider = (
  changeEmitter: vscode.EventEmitter<void | KVTreeElement | KVTreeElement[]>,
): vscode.TreeDataProvider<KVTreeElement> => {
  return {
    onDidChangeTreeData: changeEmitter.event,
    async getChildren(element) {
      if (element === undefined) {
        const settings =
          vscode.workspace
            .getConfiguration("cloudflare-devtools.kv")
            .get<{ namespaceID: string; prefix?: string; title?: string }[]>(
              "queries",
            ) ?? []

        return settings.map((s, i) => ({
          type: "query",
          namespaceID: s.namespaceID,
          prefix: s.prefix ?? "",
          title: s.title ?? s.prefix ?? `Query ${i + 1}`,
        }))
      }

      switch (element.type) {
        case "query": {
          try {
            const data = await list(element)
            return data.map((datum) => ({
              type: "entry",
              parent: element,
              namespaceID: element.namespaceID,
              ...datum,
            }))
          } catch (e) {
            vscode.window.showErrorMessage(e as string)
            return []
          }
        }
        case "entry": {
          if (element.metadata) {
            return getMetadataChildren(element.metadata)
          }
          return []
        }
        case "meta": {
          return getMetadataChildren(element.value)
        }
      }
    },
    getTreeItem(element) {
      switch (element.type) {
        case "query": {
          const item = new vscode.TreeItem(
            element.title,
            vscode.TreeItemCollapsibleState.Collapsed,
          )
          item.contextValue = "query"
          return item
        }
        case "entry": {
          const item = new vscode.TreeItem(
            element.name.slice(element.parent.prefix.length),
            element.metadata === undefined
              ? vscode.TreeItemCollapsibleState.None
              : vscode.TreeItemCollapsibleState.Collapsed,
          )
          item.description = element.ttl
            ? `Expires in ${Math.round(element.ttl / 60 / 60)} hrs`
            : false
          item.command = {
            command: "vscode.open",
            title: "Open",
            arguments: [
              uriForKV({ key: element.name, namespaceID: element.namespaceID }),
            ],
          }
          item.contextValue = "entry"
          return item
        }
        case "meta": {
          const expandable =
            typeof element.value === "object" && element.value !== null

          const item = new vscode.TreeItem(
            element.key,
            expandable
              ? element.singleChild
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
          )
          item.description = trySimpleStringRep(element.value)
          return item
        }
      }
    },
  }
}
