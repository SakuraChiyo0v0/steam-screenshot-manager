/**
 * IPC 通道与渲染层可见接口的唯一事实来源。
 *
 * 渲染层拿不到 ipcRenderer，只能调用 preload 通过 contextBridge 暴露的方法；
 * 方法清单与通道名都在这里定义，新增通道必须同时加入白名单与主进程的输入校验。
 */

import type { Err, Ok } from './errors'
import type { AppInfo, DbHealth, LibraryRootState, Settings } from './types'

export const IPC_CHANNELS = {
  appGetInfo: 'app:getInfo',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  libraryPickRoot: 'library:pickRoot',
  dbHealth: 'db:health'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/** 暴露给渲染层的方法名白名单。 */
export const EXPOSED_METHODS = [
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'pickLibraryRoot',
  'runDbHealth'
] as const

export type ExposedMethod = (typeof EXPOSED_METHODS)[number]

/** 方法名到通道的映射：preload 与主进程共用，避免两处清单漂移。 */
export const METHOD_TO_CHANNEL: Readonly<Record<ExposedMethod, IpcChannel>> = {
  getAppInfo: IPC_CHANNELS.appGetInfo,
  getSettings: IPC_CHANNELS.settingsGet,
  updateSettings: IPC_CHANNELS.settingsUpdate,
  pickLibraryRoot: IPC_CHANNELS.libraryPickRoot,
  runDbHealth: IPC_CHANNELS.dbHealth
}

export type IpcResult<T> = Ok<T> | Err

/** 渲染层可用的接口，由 preload 注入到 window.api。 */
export interface RendererApi {
  getAppInfo(): Promise<IpcResult<AppInfo>>
  getSettings(): Promise<IpcResult<Settings>>
  updateSettings(patch: Partial<Settings>): Promise<IpcResult<Settings>>
  pickLibraryRoot(): Promise<IpcResult<LibraryRootState>>
  runDbHealth(): Promise<IpcResult<DbHealth>>
}
