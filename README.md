# SGF 棋谱变化树解析与分支游标后端

本地运行的 SGF FF[4] 棋谱结构服务：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无外部服务）。只提供 HTTP API 与 CLI，**不做任何围棋规则判断**：不检查落子合法性、不计分、不生成棋盘图像或网页。

## 功能

- 导入 UTF-8 SGF 文本集合（一个集合可含多棵 GameTree）
- 自行实现 Collection / GameTree / Sequence / Node / Property 嵌套语法解析
- 方括号值转义状态机：`\]`、`\` 字面化；反斜杠 + CRLF/CR/LF 为软换行（连同换行删除）；其他被转义字符去反斜杠保留；未转义换行统一为 LF
- 类型处理：`C` 按 Text 保留换行；`N` 按 SimpleText 把空白规范为空格；`B`/`W` 只保留解码值；未知属性原样保留（不猜类型、不改写内部空白）
- 同一节点重复属性名报错；属性名限定大写 ASCII；单属性多方括号值保序
- 错误带 Unicode 码点位置与行列（未闭合值、悬空反斜杠、空树、值前缺属性名、集合后多余字符等）
- 限制：文本 ≤ 1,000,000 字符、节点 ≤ 100,000、嵌套 ≤ 1,000 层，超限正常报错
- 确定性节点路径：根为 `0`，每个子节点为 `父路径.子序号`（主线优先为 0），同一原文路径恒定
- 游标：`root` / `forward` / `back` / `choose`；分叉处必须显式 `choose`，游标互相独立
- 规范导出 SGF 并支持重新解析核验（等价性，不保证与原文逐字节相同）
- SQLite 持久化原文、SHA-256 摘要、规则版本、结构与游标；重启后继续浏览
- 导入幂等：相同 `importKey` 重复提交返回原结果；修改文本产生新棋谱；导入失败不留半棵树

## 环境

- Windows 本地，Node.js ≥ 22.5（使用内置 `node:sqlite`，开发时为 v25 验证）

## 命令

```powershell
npm install        # 安装开发依赖（typescript/tsx/@types/node）
npm run build      # 编译到 dist/
npm test           # 运行全部测试（node:test）
npm start          # 启动 API（默认端口 0 = 自动选空闲端口；--port N 或 PORT 环境变量指定）
npm run demo       # 内置演示：共同前缀/分支/转义
npm run cli -- <命令>   # 直接用 tsx 运行 CLI
```

CLI 子命令：`serve`、`import <文件> [--key K]`、`list`、`show <treeId>`、`node <treeId> <path>`、`branch <treeId> [path]`、`export <treeId>`、`verify <treeId>`、`cursor-new`、`cursor-show`、`move <cursorId> <forward|back|choose|root> [branch]`、`demo`。

数据目录默认为项目内 `./data`（可用 `SGF_DATA_DIR` 覆盖），SQLite 文件为 `data/sgf.db`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/import` | `{text, importKey?}` 导入集合 |
| GET | `/api/trees` | 列出棋谱 |
| GET | `/api/trees/:id` | 概要 + 缩进树视图 |
| GET | `/api/trees/:id/node?path=` | 查询节点属性/子分支/祖先路径 |
| GET | `/api/trees/:id/branch?path=` | 打印所选分支 |
| GET | `/api/trees/:id/export` | 规范导出 SGF |
| POST | `/api/trees/:id/verify` | 导出后重新解析核验 |
| POST | `/api/cursors` | `{treeId}` 创建游标 |
| GET | `/api/cursors/:id` | 查看游标 |
| POST | `/api/cursors/:id/move` | `{op: forward|back|choose|root, branch?}` |

错误统一返回 `{error: {code, message, pos?, line?, col?}}`，错误码见 `src/errors.ts`。

## 演示示例

`(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))`：共同前缀 2 个节点（根、`B[aa]`），分叉点 `0.0` 下两个分支 `0.0.0`（1 个节点）与 `0.0.1`（2 个节点）。`npm run demo` 同时演示含 `\]`、`\\` 与软换行的注释解码。

## 明确不做的事（限制）

- 不执行围棋规则：不判断落子合法性、不提子、不计分
- 不把棋谱转换为图片或网页，无棋盘 UI
- 规范导出保证“重新解析后结构/属性/值等价”，不保证与原始文本逐字节一致
- 未知属性只保留解码字符，不猜测其类型
