/**
 * `ssm-asset` 自定义协议：渲染层按 assetId 取图。
 *
 * 渲染层永远拿不到文件系统路径；主进程每次请求都重新查库并做边界校验
 * （词法检查 + realpath 检查），越界一律拒绝（docs/architecture.md §7、§8）。
 */

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { AppError } from '@shared/errors'
import { resolveExistingAssetPath, thumbnailPathFor } from '@core/library/asset-paths'
import { findAssetLocation } from '@core/library/queries'
import { previewAbsolutePath } from '@core/library/previews'
import { readSettings } from '@core/settings/settings-store'
import { getAppContext } from './app-context'
import { requestPreview } from './preview-queue'

export const ASSET_SCHEME = 'ssm-asset'
const ASSET_HOST = 'asset'
const THUMBNAIL_HOST = 'thumb'
const ASSET_ID_PATTERN = /^[0-9a-fA-F-]{36}$/

export function assetUrl(assetId: string): string {
  return `${ASSET_SCHEME}://${ASSET_HOST}/${assetId}`
}

export function thumbnailUrl(assetId: string): string {
  return `${ASSET_SCHEME}://${THUMBNAIL_HOST}/${assetId}`
}


/**
 * 读取本地文件作为响应。
 *
 * 用 `net.fetch(file://…)` 而不是手工拼 ReadableStream：
 * 手工流在被取消（页面重载、懒加载中止）时不会及时释放文件句柄，
 * 累积后会占满该自定义协议的连接，导致后续图片请求永久 pending。
 * net.fetch 自带中止处理、范围请求与内容类型推断。
 */
function fileResponse(filePath: string): Promise<Response> {
  return net.fetch(pathToFileURL(filePath).toString(), { bypassCustomProtocolHandlers: true })
}

/** 必须在 app ready 之前调用，否则 `<img>` 无法使用该协议。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const wantsThumbnail = url.hostname === THUMBNAIL_HOST
      if (url.hostname !== ASSET_HOST && url.hostname !== THUMBNAIL_HOST) {
        return new Response(null, { status: 404 })
      }

      const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!ASSET_ID_PATTERN.test(assetId)) {
        return new Response(null, { status: 404 })
      }

      const { database } = getAppContext()
      const location = findAssetLocation(database.db, assetId)
      if (!location) {
        return new Response(null, { status: 404 })
      }

      const settings = readSettings(database.db)

      const originalPath = await resolveExistingAssetPath(location.rootPath, location.relativePath)

      if (wantsThumbnail) {
        // 1) 自建预览：尺寸与体积都优于 Steam 缩略图，且恢复出来的图库也有
        if (settings.libraryRoot) {
          const previewPath = previewAbsolutePath(settings.libraryRoot, location.sha256)
          if (existsSync(previewPath)) {
            return await fileResponse(previewPath)
          }
        }

        // 2) 来源自带的缩略图：先给用户看得见的东西，同时排队补预览
        if (location.hasThumbnail) {
          try {
            const thumbnailPath = await resolveExistingAssetPath(
              location.rootPath,
              thumbnailPathFor(location.relativePath)
            )
            if (settings.libraryRoot) {
              requestPreview({
                libraryRoot: settings.libraryRoot,
                sha256: location.sha256,
                sourceRoot: location.rootPath,
                relativePath: location.relativePath
              })
            }
            return await fileResponse(thumbnailPath)
          } catch {
            // 缩略图不可用时继续往下回退
          }
        }

        // 3) 都没有：先用原图撑住，后台补预览
        if (settings.libraryRoot) {
          requestPreview({
            libraryRoot: settings.libraryRoot,
            sha256: location.sha256,
            sourceRoot: location.rootPath,
            relativePath: location.relativePath
          })
        }
      }

      return await fileResponse(originalPath)
    } catch (error) {
      if (error instanceof AppError) {
        // 只记录原因类别，不回传路径或堆栈
        console.warn(`[资产请求被拒绝] ${error.code}`)
      } else {
        console.warn('[资产请求失败]', error instanceof Error ? error.message : '未知错误')
      }
      return new Response(null, { status: 404 })
    }
  })
}
