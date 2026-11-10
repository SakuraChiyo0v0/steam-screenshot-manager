import { describe, expect, it } from 'vitest'
import { describeError, humanizeError, splitErrorCode } from '@shared/messages'

describe('错误码翻成人话', () => {
  it('拆出错误码与细节', () => {
    expect(splitErrorCode('DAV_AUTH：远端返回 401')).toEqual({ code: 'DAV_AUTH', detail: '远端返回 401' })
    expect(splitErrorCode('LIB_PATH_INVALID')).toEqual({ code: 'LIB_PATH_INVALID', detail: '' })
    expect(splitErrorCode('远端拒绝了连接')).toEqual({ code: null, detail: '远端拒绝了连接' })
  })

  it('已知错误码给"是什么 + 怎么办"，细节保留在括号里', () => {
    const text = describeError('DAV_PATH_INVALID：创建目录返回 404：http://nas/webdav/x')
    expect(text).toContain('远端这个路径用不了')
    expect(text).toContain('用「浏览」')
    expect(text).toContain('创建目录返回 404')
    // 不再把技术错误码糊在脸上
    expect(text).not.toContain('DAV_PATH_INVALID')
  })

  it('主副文案分开给出，便于界面排版', () => {
    const human = humanizeError('DAV_TIMEOUT：网络错误：timeout')
    expect(human.title).toBe('连不上远端')
    expect(human.hint).toContain('NAS')
    expect(human.detail).toContain('timeout')
  })

  it('认不出的错误原样返回，不吞信息', () => {
    const text = describeError('某个没见过的错误')
    expect(text).toBe('某个没见过的错误')
  })
})
