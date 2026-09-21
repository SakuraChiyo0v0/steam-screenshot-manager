/**
 * 本机偏好的读写。
 *
 * 设置存放在数据库 settings 表（key/value），不通过共享 SQLite 跨端同步
 * （docs/architecture.md 第 4 节）。
 */

import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { SqliteDatabase } from '../db/sqlite'

const KEY_AUTO_COLLECT = 'auto_collect'
const KEY_AUTO_COLLECT_INTERVAL = 'auto_collect_interval_minutes'
const KEY_AUTO_BACKUP = 'auto_backup'
const KEY_CLOSE_TO_TRAY = 'close_to_tray'
const KEY_LAUNCH_AT_LOGIN = 'launch_at_login'
const KEY_LIBRARY_ROOT = 'library_root'

const BOOLEAN_KEYS = ['autoCollect', 'autoBackup', 'closeToTray', 'launchAtLogin'] as const
const NUMBER_KEYS = ['autoCollectIntervalMinutes'] as const

/** 运行时校验渲染层传来的 patch：只接受已知字段与正确类型。 */
export function isSettingsPatch(value: unknown): value is Partial<Settings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const allowed = new Set<string>([
    ...BOOLEAN_KEYS,
    ...NUMBER_KEYS,
    'libraryRoot'
  ])
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) {
      return false
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in candidate && typeof candidate[key] !== 'boolean') {
      return false
    }
  }
  for (const key of NUMBER_KEYS) {
    const raw = candidate[key]
    if (key in candidate && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 5 || raw > 1440)) {
      return false
    }
  }
  if (
    'libraryRoot' in candidate &&
    candidate.libraryRoot !== null &&
    typeof candidate.libraryRoot !== 'string'
  ) {
    return false
  }
  return true
}

export function readSettings(db: SqliteDatabase): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const stored = new Map<string, string>()
  for (const row of rows) {
    stored.set(String(row.key), String(row.value))
  }

  const readBoolean = (key: string, fallback: boolean): boolean => {
    const value = stored.get(key)
    return value === undefined ? fallback : value === '1'
  }
  const autoCollectValue = stored.get(KEY_AUTO_COLLECT)
  const libraryRootValue = stored.get(KEY_LIBRARY_ROOT)
  const intervalValue = Number(stored.get(KEY_AUTO_COLLECT_INTERVAL))

  return {
    autoCollect:
      autoCollectValue === undefined ? DEFAULT_SETTINGS.autoCollect : autoCollectValue === '1',
    autoCollectIntervalMinutes:
      Number.isFinite(intervalValue) && intervalValue >= 5
        ? intervalValue
        : DEFAULT_SETTINGS.autoCollectIntervalMinutes,
    autoBackup: readBoolean(KEY_AUTO_BACKUP, DEFAULT_SETTINGS.autoBackup),
    closeToTray: readBoolean(KEY_CLOSE_TO_TRAY, DEFAULT_SETTINGS.closeToTray),
    launchAtLogin: readBoolean(KEY_LAUNCH_AT_LOGIN, DEFAULT_SETTINGS.launchAtLogin),
    libraryRoot: libraryRootValue && libraryRootValue.length > 0 ? libraryRootValue : null
  }
}

/** 只写入 patch 中出现的字段；整体在一个事务里完成。 */
export function writeSettings(db: SqliteDatabase, patch: Partial<Settings>): Settings {
  db.transaction(() => {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    if (patch.autoCollect !== undefined) {
      upsert.run(KEY_AUTO_COLLECT, patch.autoCollect ? '1' : '0')
    }
    if (patch.autoCollectIntervalMinutes !== undefined) {
      upsert.run(KEY_AUTO_COLLECT_INTERVAL, String(patch.autoCollectIntervalMinutes))
    }
    if (patch.autoBackup !== undefined) {
      upsert.run(KEY_AUTO_BACKUP, patch.autoBackup ? '1' : '0')
    }
    if (patch.closeToTray !== undefined) {
      upsert.run(KEY_CLOSE_TO_TRAY, patch.closeToTray ? '1' : '0')
    }
    if (patch.launchAtLogin !== undefined) {
      upsert.run(KEY_LAUNCH_AT_LOGIN, patch.launchAtLogin ? '1' : '0')
    }
    if (patch.libraryRoot !== undefined) {
      if (patch.libraryRoot === null) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(KEY_LIBRARY_ROOT)
      } else {
        upsert.run(KEY_LIBRARY_ROOT, patch.libraryRoot)
      }
    }
  })

  return readSettings(db)
}
