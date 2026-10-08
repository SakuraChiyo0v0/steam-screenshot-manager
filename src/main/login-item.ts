import { app } from 'electron'

/** 与启动入口解耦，设置接口不会因为导入函数而重复启动应用。 */
export function applyLoginItem(enabled: boolean): void {
  try { app.setLoginItemSettings({ openAtLogin: enabled, args: [] }) }
  catch (error) { console.warn('[启动项] 设置失败：', error instanceof Error ? error.message : String(error)) }
}
