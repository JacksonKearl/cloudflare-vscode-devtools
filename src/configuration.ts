import * as vscode from "vscode"

export const getQueryConfig = () =>
  vscode.workspace.getConfiguration("cloudflare-devtools.kv").get<
    {
      namespaceID: string
      prefix?: string
      title?: string
      autoExpandMetadata?: boolean
    }[]
  >("queries") ?? []
