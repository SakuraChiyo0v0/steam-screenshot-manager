import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  DavClient,
  basicAuthHeader,
  classifyDavFailure,
  joinRemotePath,
  parseRetryAfterMs,
  probeDavBases,
  splitDavUrl
} from '@core/sync/webdav'

describe('远端路径拼接', () => {
  it('把根路径与相对路径拼成编码后的绝对路径', () => {
    expect(joinRemotePath('', 'steam-gallery-v1/abc/library.json')).toBe(
      '/steam-gallery-v1/abc/library.json'
    )
    expect(joinRemotePath('screenshots', 'originals/a/b/c.jpg')).toBe(
      '/screenshots/originals/a/b/c.jpg'
    )
  })

  it('中文与空格被正确编码', () => {
    expect(joinRemotePath('', '中文 目录/文件.txt')).toBe(
      `/${encodeURIComponent('中文 目录')}/${encodeURIComponent('文件.txt')}`
    )
  })

  it('拒绝绝对路径、上级目录与空字节', () => {
    expect(() => joinRemotePath('', '/etc/passwd')).toThrow(AppError)
    expect(() => joinRemotePath('', '../outside.json')).toThrow(AppError)
    expect(() => joinRemotePath('root', 'a/../../b')).toThrow(AppError)
    expect(() => joinRemotePath('', 'C:/windows/system32')).toThrow(AppError)
    expect(() => joinRemotePath('', 'a\u0000b')).toThrow(AppError)
  })
})

describe('Retry-After 解析', () => {
  it('支持秒数与 HTTP 日期，并封顶', () => {
    expect(parseRetryAfterMs({ 'retry-after': '2' })).toBe(2000)
    expect(parseRetryAfterMs({ 'retry-after': '99999' })).toBe(5 * 60 * 1000)
    expect(parseRetryAfterMs({})).toBeNull()
    expect(parseRetryAfterMs({ 'retry-after': 'not-a-value' })).toBeNull()
  })
})

describe('故障分类', () => {
  const context = { contentType: 'application/xml', bodyHead: '', retryAfterMs: null }

  it('认证与权限快速失败且不可重试', () => {
    expect(classifyDavFailure(401, context).code).toBe('DAV_AUTH')
    expect(classifyDavFailure(403, context).code).toBe('DAV_FORBIDDEN')
  })

  it('限流与容量不足归为可重试', () => {
    expect(classifyDavFailure(429, { ...context, retryAfterMs: 1000 }).code).toBe('DAV_RATE_LIMIT')
    expect(classifyDavFailure(429, { ...context, retryAfterMs: 1000 }).retryAfterMs).toBe(1000)
    expect(classifyDavFailure(507, context).code).toBe('DAV_CAPACITY')
    expect(classifyDavFailure(500, context).code).toBe('DAV_TIMEOUT')
  })

  it('423 Locked 归为可重试（真实服务在索引/扫描期间会短暂返回）', () => {
    expect(classifyDavFailure(423, context).code).toBe('DAV_TIMEOUT')
  })

  it('409 归为路径错误（父目录不存在），不可重试', () => {
    const failure = classifyDavFailure(409, context)
    expect(failure.code).toBe('LIB_PATH_INVALID')
    expect(failure.message).toContain('父目录不存在')
  })

  it('网页内容识别为非 WebDAV，即使是 200', () => {
    expect(
      classifyDavFailure(200, {
        contentType: 'text/html',
        bodyHead: '<!doctype html>',
        retryAfterMs: null
      }).code
    ).toBe('DAV_NOT_WEBDAV')
  })
})

describe('凭据代持', () => {
  it('用户名与密码都为空时不生成 Authorization（交给前置网关注入）', () => {
    expect(basicAuthHeader({ username: '', password: '' })).toBeNull()
  })

  it('只要有一侧非空就生成 Basic 头', () => {
    const expected = `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`
    expect(basicAuthHeader({ username: 'user', password: 'pass' })).toBe(expected)
    expect(basicAuthHeader({ username: 'user', password: '' })).not.toBeNull()
    expect(basicAuthHeader({ username: '', password: 'pass' })).not.toBeNull()
  })
})

describe('入口探测与 404 诊断', () => {
  /** 假 NAS：只有 /webdav 这一支是 WebDAV，其它路径一律 404（和实测的 kura 网关一致）。 */
  const startFakeNas = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = http.createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
      const inDav = path === '/webdav' || path.startsWith('/webdav/')
      if (!inDav) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'content-type': 'application/xml' })
        res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>')
        return
      }
      if (req.method === 'MKCOL') {
        res.writeHead(201)
        res.end()
        return
      }
      res.writeHead(405)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      url,
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }

  it('地址拆成源与根路径：路径部分能逐级创建', () => {
    const split = splitDavUrl('http://nas:8898/webdav/home/AmeChan/AmeBackup/Steam%E6%88%AA%E5%9B%BE')
    expect(split.baseUrl).toBe('http://nas:8898')
    // 路径整段都留在 rootPath 里（含 WebDAV 入口前缀），这样逐级 MKCOL 能把它建出来
    expect(split.rootPath).toBe('webdav/home/AmeChan/AmeBackup/Steam截图')
  })

  it('只填主机名时，自动试常见前缀并给出可用的那个', async () => {
    const nas = await startFakeNas()
    try {
      const probes = await probeDavBases(nas.url, { username: '', password: '' })
      expect(probes[0]!.url).toBe(nas.url)
      expect(probes[0]!.ok).toBe(false)
      const webdav = probes.find((item) => item.url === `${nas.url}/webdav`)
      expect(webdav?.ok).toBe(true)
      expect(webdav?.status).toBe(207)
    } finally {
      await nas.close()
    }
  })

  it('MKCOL 404 的报错带上实际请求的 URL 与排查方向', async () => {
    const nas = await startFakeNas()
    try {
      const client = new DavClient({
        baseUrl: nas.url,
        rootPath: 'backup',
        credential: { username: '', password: '' }
      })
      await expect(client.createCollection('steam-gallery-v1')).rejects.toThrow(AppError)
      await expect(client.createCollection('steam-gallery-v1')).rejects.toThrow(
        /创建目录返回 404.*\/backup\/steam-gallery-v1/
      )
      await expect(client.createCollection('steam-gallery-v1')).rejects.toThrow(/前缀/)
    } finally {
      await nas.close()
    }
  })

  it('可用入口下算出的完整 URL 与实际请求一致（报错时能照着点）', async () => {
    const nas = await startFakeNas()
    try {
      const client = new DavClient({
        baseUrl: nas.url,
        rootPath: 'webdav/home/AmeChan/AmeBackup/Steam截图',
        credential: { username: '', password: '' }
      })
      expect(await client.collectionExists('')).toBe(true)
      expect(client.absoluteUrl('steam-gallery-v1/x.json')).toBe(
        `${nas.url}/webdav/home/AmeChan/AmeBackup/${encodeURIComponent('Steam截图')}/steam-gallery-v1/x.json`
      )
    } finally {
      await nas.close()
    }
  })
})
