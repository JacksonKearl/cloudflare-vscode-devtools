import { Uri } from "vscode"

export const kvScheme = "cloudflare-devtools-kv"

export const uriForKV = (opts: { namespaceID: string; key: string }) =>
  Uri.from({
    scheme: kvScheme,
    authority: opts.namespaceID,
    path: "/" + opts.key,
  })

export const kvForUri = (uri: Uri) => {
  if (uri.scheme !== kvScheme) {
    throw Error("Attempting to KV decode a non-KV URI: " + uri.toString())
  }
  return { namespaceID: uri.authority, key: uri.path.slice(1) }
}
