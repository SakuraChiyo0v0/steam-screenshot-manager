/**
 * 预加载脚本。
 *
 * 只通过 contextBridge 暴露 shared/ipc.ts 里列出的白名单方法；
 * 不暴露 ipcRenderer 本身，不暴露 fs/path 或任何路径拼接能力。
 * 在 sandbox: true 下以 CommonJS 加载，因此这里不使用 ESM 专有语法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { EXPOSED_METHODS, IPC_EVENTS, METHOD_TO_CHANNEL } from '@shared/ipc'

const api: Record<string, (payload?: unknown) => Promise<unknown>> = {}

for (const method of EXPOSED_METHODS) {
  const channel = METHOD_TO_CHANNEL[method]
  api[method] = (payload?: unknown) => ipcRenderer.invoke(channel, payload)
}

// 主进程推送的进度事件，单独桥接；同一时刻每类只保留一个监听器，避免重复订阅。
type IpcListener = (event: unknown, payload: unknown) => void

const eventListeners: Record<string, IpcListener | null> = {}

function bridgeEvent(name: string, channel: string): void {
  api[name] = (listener?: unknown) => {
    if (typeof listener !== 'function') {
      return Promise.resolve()
    }
    const existing = eventListeners[channel]
    if (existing) {
      ipcRenderer.removeListener(channel, existing)
      eventListeners[channel] = null
    }
    const typed = listener as (payload: unknown) => void
    const wrapped: IpcListener = (_event, payload) => typed(payload)
    eventListeners[channel] = wrapped
    ipcRenderer.addListener(channel, wrapped)
    return Promise.resolve()
  }
}

function unbridgeEvent(name: string, channel: string): void {
  api[name] = () => {
    const existing = eventListeners[channel]
    if (existing) {
      ipcRenderer.removeListener(channel, existing)
      eventListeners[channel] = null
    }
    return Promise.resolve()
  }
}

bridgeEvent('onScanProgress', IPC_EVENTS.scanProgress)
unbridgeEvent('offScanProgress', IPC_EVENTS.scanProgress)
bridgeEvent('onArchiveProgress', IPC_EVENTS.archiveProgress)
unbridgeEvent('offArchiveProgress', IPC_EVENTS.archiveProgress)
bridgeEvent('onExportProgress', IPC_EVENTS.exportProgress)
unbridgeEvent('offExportProgress', IPC_EVENTS.exportProgress)

contextBridge.exposeInMainWorld('api', api)