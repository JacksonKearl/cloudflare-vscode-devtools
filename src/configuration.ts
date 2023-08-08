import * as vscode from "vscode"
import * as toml from "toml"
import { TextDecoder } from "util"
import { dirname } from "path"

export type NamespaceConfig = { local?: boolean; basePath: string } & (
  | { binding: string; preview?: boolean; id?: never }
  | { id: string; binding?: never; preview?: never }
)

const decoder = new TextDecoder()

let wranglerConfigFileCache:
  | Promise<
      {
        uri: vscode.Uri
        content: {
          kv_namespaces: { binding: string; id: string; preview_id: string }[]
        }
      }[]
    >
  | undefined

export const refreshWranglerConfigFileCache = async () => {
  wranglerConfigFileCache = (async () => {
    const allFiles = await vscode.workspace.findFiles("**/wrangler.{toml,json}")
    const contents = (
      await Promise.all(
        allFiles.map(async (file) => ({
          uri: file,
          content: decoder.decode(await vscode.workspace.fs.readFile(file)),
        })),
      )
    ).map((file) => ({
      uri: file.uri,
      workspace: vscode.workspace.getWorkspaceFolder(file.uri)?.name,
      content: file.uri.path.endsWith(".json")
        ? JSON.parse(file.content)
        : toml.parse(file.content),
    }))

    console.log({ contents })
    return contents
  })()
}

export const getQueriesConfig = async () => {
  if (!wranglerConfigFileCache) refreshWranglerConfigFileCache()
  const configFileContents = await wranglerConfigFileCache

  const queries: {
    namespace: NamespaceConfig
    prefix?: string
    title?: string
  }[] = []

  configFileContents?.forEach((configFile) => {
    configFile.content.kv_namespaces.forEach((namespace) => {
      const baseTitle = namespace.binding
      const basePath = dirname(configFile.uri.fsPath)
      queries.push({
        namespace: { id: namespace.id, basePath },
        title: baseTitle + " (prod)",
      })
      queries.push({
        namespace: { id: namespace.preview_id, basePath },
        title: baseTitle + " (prev)",
      })
      queries.push({
        namespace: { id: namespace.preview_id, basePath, local: true },
        title: baseTitle + " (local)",
      })
    })
  })

  queries.push(
    ...(vscode.workspace.getConfiguration("cloudflare-devtools.kv").get<
      {
        namespace: NamespaceConfig
        prefix?: string
        title?: string
      }[]
    >("queries") ?? []),
  )

  return queries
}

export const getWranglerPathConfig = () =>
  vscode.workspace
    .getConfiguration("cloudflare-devtools")
    .get<string>("wranglerPath") ?? "wrangler"
