/**
 * 预加载脚本。
 *
 * 只通过 contextBridge 暴露 shared/ipc.ts 里列出的白名单方法；
 * 不暴露 ipcRenderer 本身，不暴露 fs/path 或任何路径拼接能力。
 * 在 sandbox: true 下以 CommonJS 加载，因此这里不使用 ESM 专有语法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { EXPOSED_METHODS, IPC_EVENTS, METHOD_TO_CHANNEL } from '@shared/ipc'

type ProgressListener = (progress: unknown) => void

const api: Record<string, (payload?: unknown) => Promise<unknown>> = {}

for (const method of EXPOSED_METHODS) {
  const channel = METHOD_TO_CHANNEL[method]
  api[method] = (payload?: unknown) => ipcRenderer.invoke(channel, payload)
}

// 扫描进度是主进程推送的事件，单独桥接；同一时刻只保留一个监听器，避免重复订阅。
let progressListener: ((event: unknown, payload: unknown) => void) | null = null

api['onScanProgress'] = (listener?: unknown) => {
  if (typeof listener !== 'function') {
    return Promise.resolve()
  }
  if (progressListener) {
    ipcRenderer.removeListener(IPC_EVENTS.scanProgress, progressListener)
    progressListener = null
  }
  const typed = listener as ProgressListener
  progressListener = (_event: unknown, payload: unknown) => typed(payload)
  ipcRenderer.addListener(IPC_EVENTS.scanProgress, progressListener)
  return Promise.resolve()
}

api['offScanProgress'] = () => {
  if (progressListener) {
    ipcRenderer.removeListener(IPC_EVENTS.scanProgress, progressListener)
    progressListener = null
  }
  return Promise.resolve()
}

contextBridge.exposeInMainWorld('api', api)
