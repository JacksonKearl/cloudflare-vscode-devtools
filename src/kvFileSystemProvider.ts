import * as vscode from "vscode"
import { get, put } from "./wrangler"
import { kvForUri } from "./uris"

export const kvFileSystemProvider = (
  emitter: vscode.EventEmitter<vscode.FileChangeEvent[]>,
): vscode.FileSystemProvider => ({
  onDidChangeFile: emitter.event,

  watch(uri, options) {
    return { dispose() {} }
  },

  async readFile(uri) {
    try {
      return await get(kvForUri(uri))
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
  },

  async writeFile(uri, content, options) {
    await put({
      ...kvForUri(uri),
      value: content,
    })
  },

  async stat(uri) {
    const contents = await this.readFile(uri)
    return {
      size: contents.length,
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
    }
  },

  createDirectory(uri) {
    throw new Error("Not Implemented - createDirectory")
  },
  readDirectory(uri) {
    throw new Error("Not Implemented - readDirectory")
  },
  rename(oldUri, newUri, options) {
    throw new Error("Not Implemented - rename")
  },
  delete(uri, options) {
    throw new Error("Not Implemented - delete")
  },
})
