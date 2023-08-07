import * as vscode from "vscode"

export type NamespaceConfig = { local?: boolean } & (
  | { binding: string; preview?: boolean; id?: never }
  | { id: string; binding?: never; preview?: never }
)

export const getQueriesConfig = () =>
  vscode.workspace.getConfiguration("cloudflare-devtools.kv").get<
    {
      namespace: NamespaceConfig
      prefix?: string
      title?: string
    }[]
  >("queries") ?? []

export const getWranglerPathConfig = () =>
  vscode.workspace
    .getConfiguration("cloudflare-devtools")
    .get<string>("wranglerPath") ?? "wrangler"
