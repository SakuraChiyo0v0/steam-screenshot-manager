/**
 * 渲染层与桌面接口之间的薄适配层。
 *
 * 浏览器预览（pnpm dev:ui）没有 window.api，这里统一返回 null，
 * 由页面显示"需要桌面环境"的空态，而不是抛出未处理异常。
 */

import type { IpcResult, RendererApi } from '@shared/ipc'

export function getApi(): RendererApi | null {
  if (typeof window === 'undefined') {
    return null
  }
  return typeof window.api === 'undefined' ? null : window.api
}

/** 把 { ok, data } / { ok, code, message } 统一成"成功返回数据、失败抛错"。 */
export async function call<T>(action: (api: RendererApi) => Promise<IpcResult<T>>): Promise<T> {
  const api = getApi()
  if (!api) {
    throw new Error('需要桌面环境：当前没有可用的桌面接口。')
  }
  const result = await action(api)
  if (!result.ok) {
    throw new Error(`${result.code}：${result.message}`)
  }
  return result.data
}
