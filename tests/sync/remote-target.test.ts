import { describe, expect, it } from 'vitest'
import { checkBackupTarget } from '@core/sync/remote-target'

const LIBRARY = 'Z:\\home\\AmeChan\\AmeBackup\\Steam截图'

describe('备份目标检查', () => {
  it('同一个目录被拒（真实踩过的配置）', () => {
    expect(checkBackupTarget({ kind: 'folder', address: LIBRARY, libraryRoot: LIBRARY })).toContain(
      '不能和本机图库'
    )
  })

  it('互相包含也被拒', () => {
    expect(
      checkBackupTarget({ kind: 'folder', address: 'Z:\\home\\AmeChan\\AmeBackup', libraryRoot: LIBRARY })
    ).not.toBeNull()
    expect(
      checkBackupTarget({ kind: 'folder', address: LIBRARY + '\\staging', libraryRoot: LIBRARY })
    ).not.toBeNull()
  })

  it('不同目录放行；WebDAV 不参与比较', () => {
    expect(
      checkBackupTarget({ kind: 'folder', address: 'Z:\\home\\AmeChan\\Backup\\Steam', libraryRoot: LIBRARY })
    ).toBeNull()
    expect(
      checkBackupTarget({ kind: 'webdav', address: LIBRARY, libraryRoot: LIBRARY })
    ).toBeNull()
  })

  it('还没选图库时不拦', () => {
    expect(checkBackupTarget({ kind: 'folder', address: LIBRARY, libraryRoot: null })).toBeNull()
  })
})
