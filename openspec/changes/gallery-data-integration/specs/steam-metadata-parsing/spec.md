## ADDED Requirements

### Requirement: 文本 VDF 与 ACF 解析

系统 MUST 使用 VDF 解析器（而非仅适配单一缩进的正则）读取 `libraryfolders.vdf`、`appmanifest_*.acf` 与 `screenshots.vdf`。

#### Scenario: 解析游戏库清单
- **WHEN** 读取 `libraryfolders.vdf`
- **THEN** 得到各库路径，并能读取其中 `apps` 子表给出的已安装 AppID 集合

#### Scenario: 解析安装清单名称
- **WHEN** 读取 `steamapps/appmanifest_<AppID>.acf`
- **THEN** 得到 `appid` 与 `name`；名称缺失时不影响截图索引

#### Scenario: 解析截图索引
- **WHEN** 读取 `760/screenshots.vdf`
- **THEN** 每个条目能给出 `filename`、`creation`（Unix 时间戳）、`width`、`height`，并与磁盘文件按相对路径对应

#### Scenario: 解析失败
- **WHEN** 某个 VDF/ACF 文件损坏或字段变化导致解析失败
- **THEN** 记录该文件解析失败并继续扫描磁盘文件，不中断整批扫描，也不写回"修复"来源文件

### Requirement: 二进制 shortcuts.vdf 解析

系统 MUST 解析二进制 `shortcuts.vdf` 以取得非 Steam 快捷方式的 `appid` 与 `AppName`，MUST 按 `gameID = (storedAppid << 32) | 0x02000000` 换算目录名。

#### Scenario: 非 Steam 游戏名称
- **WHEN** 截图目录名是超过 2³² 的高位 gameID，且 `shortcuts.vdf` 中存在对应 `storedAppid`
- **THEN** 该游戏使用快捷方式名称，并被标记为非 Steam 游戏

#### Scenario: 找不到对应快捷方式
- **WHEN** 高位 gameID 在 `shortcuts.vdf` 中找不到匹配项
- **THEN** 游戏以 gameID 作为显示名继续入库，不丢弃该游戏的截图

### Requirement: 拍摄时间来源标注

系统 MUST 为每张截图标注拍摄时间的来源，MUST NOT 把导入时间伪装成拍摄时间。

#### Scenario: 索引中有时间
- **WHEN** `screenshots.vdf` 中存在对应条目的 `creation`
- **THEN** 拍摄时间取自该值，来源标记为截图索引

#### Scenario: 索引中没有时间
- **WHEN** 截图不在索引中（实测存在此类文件）
- **THEN** 拍摄时间回退为文件修改时间并标记来源为文件时间；两者都不可用时显示未知
