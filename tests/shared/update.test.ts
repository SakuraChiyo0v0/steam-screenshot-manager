import { describe, expect, it } from 'vitest'
import { friendlyUpdateError, isNoReleaseError, updateSource } from '@shared/update'

describe('更新错误翻译', () => {
  it('还没发过版本算「没有可用版本」，不算失败', () => {
    const error = Object.assign(new Error('No published versions on GitHub'), {
      code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    })
    expect(isNoReleaseError(error)).toBe(true)
    expect(friendlyUpdateError(error)).toContain('还没有可用的版本')
  })

  it('断网、超时、拒绝连接、限流各有中文说明', () => {
    expect(friendlyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toContain('网络')
    expect(friendlyUpdateError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toContain('超时')
    expect(friendlyUpdateError(new Error('connect ECONNREFUSED 127.0.0.1'))).toContain('拒绝')
    expect(friendlyUpdateError(new Error('HTTP error 403 rate limit'))).toContain('限制')
    expect(friendlyUpdateError(new Error('sha512 checksum mismatch'))).toContain('校验')
  })

  it('认不出的错误也给一句能看的话（不把英文堆栈丢给界面）', () => {
    expect(friendlyUpdateError(new Error('boom'))).toContain('详情见日志')
    expect(friendlyUpdateError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_OTHER' }))).toContain('详情见日志')
  })
})

describe('更新源选择', () => {
  it('工具模式永不接更新源', () => {
    expect(updateSource({ packaged: true, toolMode: true, env: {} })).toEqual({ kind: 'off' })
  })

  it('打包后走 GitHub Releases', () => {
    expect(updateSource({ packaged: true, toolMode: false, env: {} })).toEqual({ kind: 'github' })
  })

  it('开发运行默认不接；设了 SSM_UPDATE_URL 才接，且只认 http(s)', () => {
    expect(updateSource({ packaged: false, toolMode: false, env: {} })).toEqual({ kind: 'off' })
    expect(
      updateSource({ packaged: false, toolMode: false, env: { SSM_UPDATE_URL: 'http://127.0.0.1:8899' } })
    ).toEqual({ kind: 'generic', url: 'http://127.0.0.1:8899' })
    expect(
      updateSource({ packaged: false, toolMode: false, env: { SSM_UPDATE_URL: 'file:///c:/tmp' } })
    ).toEqual({ kind: 'off' })
  })
})
