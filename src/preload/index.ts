/**
 * 预加载脚本。
 *
 * 只通过 contextBridge 暴露 shared/ipc.ts 里列出的白名单方法；
 * 不暴露 ipcRenderer 本身，不暴露 fs/path 或任何路径拼接能力。
 * 在 sandbox: true 下以 CommonJS 加载，因此这里不使用 ESM 专有语法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { EXPOSED_METHODS, METHOD_TO_CHANNEL } from '@shared/ipc'

const api: Record<string, (payload?: unknown) => Promise<unknown>> = {}

for (const method of EXPOSED_METHODS) {
  const channel = METHOD_TO_CHANNEL[method]
  api[method] = (payload?: unknown) => ipcRenderer.invoke(channel, payload)
}

contextBridge.exposeInMainWorld('api', api)
