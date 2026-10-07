# SGF 棋谱变化树解析与分支游标后端

本地可运行的 SGF FF[4] 棋谱结构服务：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`），仅提供 HTTP API 与 CLI，无棋盘 UI。

**重要声明：本服务不执行围棋规则。** 不判断落子是否合法、不计分、不把棋谱转换成图片或网页；`B`/`W` 属性只保留解码后的字符串值，不扩展成任何棋盘操作。

## 功能

- 导入 UTF-8 SGF 文本集合（一个集合可含多棵 GameTree），解析主线与变化分支
- 自行实现 Collection / GameTree / Sequence / Node / Property 嵌套语法解析
- 方括号值转义状态机：`\]`、`\`、软换行（`\`+CRLF/CR/LF 整体删除）、其他转义去反斜杠保留；未转义换行统一为 LF
- 类型处理：`C` 按 Text 保留换行；`N` 按 SimpleText 把空白规范为单个空格；未知合法属性原样保留解码字符，不猜测类型、不改写空白
- 同一节点重复属性名视为格式错误；属性名限定大写 ASCII 字母；单属性多值且保持顺序
- 错误返回以 Unicode 码点计的偏移及行列（未闭合值、悬空反斜杠、空树、值前缺属性名、集合后多余字符等）
- 限制文本长度 / 节点数 / 嵌套深度（见 `src/sgf.ts` 的 `DEFAULT_LIMITS`），超限正常报错
- 确定路径标识：根为 `R`，子节点为 `<父路径>.<子序号>`（0 基，主线恒为 0，变化分支按原文顺序为 1、2、…）；同一原文再次导入得到相同路径
- 游标：从根进入、向后走一步（多分支必须显式选择）、退回父节点；游标互相独立，持久化在 SQLite，重启后可继续
- 确定性导出 SGF 并支持"导出 → 重新解析 → 结构等价"核验（不声称与原文逐字节相同）
- 导入幂等：同一文本重复提交返回原结果；修改文本产生新棋谱，旧路径不会被新版本重新解释；导入失败整体回滚，不留半棵树

## 环境要求

- Windows 本地，Node.js 大于等于 22.5（推荐 24 以上，开发使用 Node 25）；不依赖 Docker / WSL / 付费服务 / 在线 API
- 依赖仅 `typescript` 与 `@types/node`（开发依赖）

## 命令

```powershell
npm install        # 安装开发依赖
npm run build      # tsc 构建到 dist/
npm test           # 运行全部测试（node --test）
npm start          # 启动 API 服务（默认选择空闲端口）
npm run demo       # 运行演示（共同前缀/两分支 + 转义注释）
node scripts/smoke.ts        # API 冒烟测试
node src/cli.ts <命令>       # CLI（见下）
```

端口配置：`node src/cli.ts serve --port=8080` 或环境变量 `PORT`；默认 `0`（操作系统分配空闲端口），启动后打印实际端口。

数据目录：项目内 `data/sgf.db`；可用环境变量 `SGF_DATA_DIR` / `SGF_DB` 覆盖。

## CLI

```
node src/cli.ts serve [--port=N]     启动 API 服务
node src/cli.ts import <文件>        导入 SGF 集合（幂等）
node src/cli.ts list                 列出棋谱
node src/cli.ts tree <gameId>        缩进树 + 属性表展示
node src/cli.ts node <gameId> [path] 查询节点（默认 R），含到根路径
node src/cli.ts cursor create <gameId>
node src/cli.ts cursor forward <cursorId> [branch]
node src/cli.ts cursor back <cursorId>
node src/cli.ts cursor show <cursorId>
node src/cli.ts export <gameId> [文件]  规范导出
node src/cli.ts verify <gameId>         导出-重解析核验
node src/cli.ts demo                    演示
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/collections` | 导入集合，body `{"text": "..."}`，返回 `{importHash, gameIds, duplicate}` |
| GET | `/api/games` | 列出棋谱 |
| GET | `/api/games/:id` | 棋谱元信息（含原文） |
| GET | `/api/games/:id/node?path=R.0.1` | 查询节点属性、子分支与到根路径 |
| GET | `/api/games/:id/export` | 规范导出 SGF |
| POST | `/api/games/:id/verify` | 导出-重解析结构等价核验 |
| POST | `/api/cursors` | 创建游标，body `{"gameId": 1}` |
| GET | `/api/cursors/:cid` | 游标状态 |
| POST | `/api/cursors/:cid/forward` | 前进一步，body 可含 `{"branch": n}` |
| POST | `/api/cursors/:cid/back` | 退回父节点 |

错误响应统一为 `{"error": {code, message, ...}}`；SGF 解析错误额外含 `offset`（码点）、`line`、`column`。

### 错误码

- 解析：`SGF_UNCLOSED_VALUE`、`SGF_DANGLING_BACKSLASH`、`SGF_EMPTY_TREE`、`SGF_MISSING_PROP_IDENT`、`SGF_BAD_PROP_NAME`、`SGF_DUPLICATE_PROPERTY`、`SGF_TRAILING_GARBAGE`、`SGF_UNEXPECTED_CHAR`、`SGF_EMPTY_COLLECTION`、`SGF_LIMIT_EXCEEDED`
- 服务：`BAD_REQUEST`、`BAD_JSON`、`GAME_NOT_FOUND`、`NODE_NOT_FOUND`、`CURSOR_NOT_FOUND`、`CURSOR_STALE`、`NO_CHILD`、`BRANCH_REQUIRED`、`BRANCH_OUT_OF_RANGE`、`AT_ROOT`、`NOT_FOUND`

## 演示示例

`(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))`：共同前缀 `R`(FF/GM) 到 `R.0`(B[aa])，分叉点 `R.0` 有两个子分支：`R.0.0`（W[bb]，1 个节点）与 `R.0.1`（W[cc];B[dd]，2 个节点）。`npm run demo` 还会演示含 `\]`、`\\` 与软换行的注释解析。

## 测试

`npm test` 覆盖：手写预期树核对（非仅往返）、多棋谱集合、多值属性、未知属性、空值、中文码点位置、转义/软换行、分支退回、非法语法、限制超限、导出稳定性、无环/单父校验、导入幂等与回滚、游标独立性与重启后一致性。

## 限制与假设

- 仅支持 FF[4] 风格结构语法；不校验 `FF`/`GM` 的具体取值语义
- 规范导出保证"重新解析后结构、属性、值等价"，不保证与原文逐字节一致
- 路径标识在单次导入的结构内确定；文本修改后生成新棋谱，旧游标指向旧版本
- `node:sqlite` 在 Node 25 仍标记为实验特性（启动时有 ExperimentalWarning，不影响功能）
