import * as vscode from "vscode"
import { ListResponseDatum, list } from "./wrangler"
import { uriForKV } from "./uris"
import { getQueryConfig } from "./configuration"

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

const getMetadataChildren = (
  metadata: any,
  parent: KVTreeElement,
): KVMetaElement[] => {
  if (metadata === undefined) {
    return []
  }
  const str = trySimpleStringRep(metadata)
  if (str) {
    return [{ type: "meta", key: str, singleChild: true, parent }]
  } else {
    const entries = Object.entries(metadata)
    return entries.map(([key, value]) => ({
      type: "meta",
      key,
      value,
      singleChild: entries.length === 1,
      parent,
    }))
  }
}

export type KVQueryElement = {
  type: "query"
  namespaceID: string
  prefix: string
  title: string
  autoExpand: boolean
}

export type KVEntryElement = {
  type: "entry"
  namespaceID: string
  parent: KVQueryElement
} & ListResponseDatum

export type KVMetaElement = {
  type: "meta"
  key: string
  value?: any
  singleChild: boolean
  parent: KVTreeElement
}
export type KVTreeElement = KVQueryElement | KVEntryElement | KVMetaElement

export const kvTreeDataProvider = (
  changeEmitter: vscode.EventEmitter<void | KVTreeElement | KVTreeElement[]>,
): vscode.TreeDataProvider<KVTreeElement> => {
  return {
    onDidChangeTreeData: changeEmitter.event,
    async getChildren(element) {
      if (element === undefined) {
        return getQueryConfig().map((s, i) => ({
          type: "query",
          namespaceID: s.namespaceID,
          prefix: s.prefix ?? "",
          title: s.title ?? s.prefix ?? `Query ${i + 1}`,
          autoExpand: Boolean(s.autoExpandMetadata),
        }))
      }

      switch (element.type) {
        case "query": {
          try {
            const data = await list(element, () => changeEmitter.fire(element))
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
            return getMetadataChildren(element.metadata, element)
          }
          return []
        }
        case "meta": {
          return getMetadataChildren(element.value, element)
        }
      }
    },
    getTreeItem(element) {
      let root = element.type === "query" ? element : element.parent
      while (root.type !== "query") {
        root = root.parent
      }
      const rootQuery = root as KVQueryElement

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
            element.key.slice(element.parent.prefix.length),
            element.metadata === undefined
              ? vscode.TreeItemCollapsibleState.None
              : rootQuery.autoExpand
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed,
          )

          item.description = element.expiration
            ? new Date(element.expiration * 1000).toLocaleString()
            : false
          item.command = {
            command: "vscode.open",
            title: "Open",
            arguments: [
              uriForKV({ key: element.key, namespaceID: element.namespaceID }),
            ],
          }
          item.contextValue = "entry"
          return item
        }
        case "meta": {
          const expandable =
            typeof element.value === "object" && element.value !== null
          const simple = trySimpleStringRep(element.value)
          const label = simple ? element.key + ": " + simple : element.key
          const item = new vscode.TreeItem(
            label,
            expandable
              ? element.singleChild || rootQuery.autoExpand
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.None,
          )
          item.contextValue = "meta"
          return item
        }
      }
    },
  }
}
