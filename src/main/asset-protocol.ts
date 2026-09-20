/**
 * `ssm-asset` 自定义协议：渲染层按 assetId 取图。
 *
 * 渲染层永远拿不到文件系统路径；主进程每次请求都重新查库并做边界校验
 * （词法检查 + realpath 检查），越界一律拒绝（docs/architecture.md §7、§8）。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { AppError } from '@shared/errors'
import { resolveExistingAssetPath, thumbnailPathFor } from '@core/library/asset-paths'
import { findAssetLocation } from '@core/library/queries'
import { getAppContext } from './app-context'

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


function mimeTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.avif':
      return 'image/avif'
    case '.tga':
      return 'image/x-tga'
    default:
      return 'application/octet-stream'
  }
}

async function fileResponse(filePath: string): Promise<Response> {
  const info = await stat(filePath)
  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'content-type': mimeTypeFor(filePath),
      'content-length': String(info.size),
      'cache-control': 'no-cache'
    }
  })
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

      if (wantsThumbnail && location.hasThumbnail) {
        try {
          const thumbnailPath = await resolveExistingAssetPath(
            location.rootPath,
            thumbnailPathFor(location.relativePath)
          )
          return await fileResponse(thumbnailPath)
        } catch {
          // 缩略图不可用时回退原图
        }
      }

      const originalPath = await resolveExistingAssetPath(location.rootPath, location.relativePath)
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
