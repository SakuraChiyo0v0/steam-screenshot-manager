## ADDED Requirements

### Requirement: 解析依赖不进入运行时依赖

系统 MUST 保持运行时依赖为 0：VDF 解析库 MUST 作为 devDependency 由构建打进主进程产物，MUST NOT 要求产物内包含 node_modules。

#### Scenario: 打包产物内容
- **WHEN** 检查打包后的 `app.asar`
- **THEN** 只包含构建产物与 `package.json`，不存在 `node_modules` 目录

#### Scenario: 打包产物中解析可用
- **WHEN** 在打包产物中扫描一个包含 VDF 文件的来源
- **THEN** VDF 解析正常工作，不需要外部模块

### Requirement: 打包产物可完成真实扫描

系统 MUST 能在打包产物中完成索引扫描，MUST NOT 只在开发环境可用。

#### Scenario: 打包产物中执行扫描
- **WHEN** 在打包产物里对已登记来源执行扫描
- **THEN** 扫描成功完成并写入索引，结果与开发运行一致
