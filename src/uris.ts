import * as vscode from "vscode"
import { NamespaceConfig } from "./configuration"

export const kvScheme = "cloudflare-devtools-kv"

export const uriForKV = (opts: { namespace: NamespaceConfig; key: string }) =>
  vscode.Uri.from({
    scheme: kvScheme,
    authority: encodeURIComponent(JSON.stringify(opts.namespace)),
    path: "/" + opts.key,
  })

export const kvForUri = (uri: vscode.Uri) => {
  if (uri.scheme !== kvScheme) {
    throw Error("Attempting to KV decode a non-KV URI: " + uri.toString())
  }
  return {
    namespace: JSON.parse(decodeURIComponent(uri.authority)) as NamespaceConfig,
    key: uri.path.slice(1),
  }
}

let resolveEmptyUri: (c: vscode.Uri) => void
export const emptyUri = new Promise<vscode.Uri>((c) => (resolveEmptyUri = c))

export const makeEmptyFile = (globalStorageUri: vscode.Uri) => {
  vscode.workspace.fs.createDirectory(globalStorageUri).then(async () => {
    const uri = vscode.Uri.joinPath(globalStorageUri, "empty")
    await vscode.workspace.fs.writeFile(uri, new Uint8Array())
    resolveEmptyUri(uri)
  })
}
