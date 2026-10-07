// CLI：导入、列表、节点查询、游标、打印分支、导出、核验、演示。
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Store, ApiError } from "./store.ts";
import { SgfError, ROOT_PATH, childPath } from "./sgf.ts";
import { startServer } from "./server.ts";

const DATA_DIR = process.env.SGF_DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.SGF_DB ?? join(DATA_DIR, "sgf.db");

function fmtProps(props: Record<string, string[]>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "(无属性)";
  return entries.map(([k, vs]) => k + " = " + vs.map((v) => JSON.stringify(v)).join(", ")).join("; ");
}

function die(e: unknown): never {
  if (e instanceof SgfError) {
    console.error("SGF 解析错误 [" + e.code + "] " + e.message + " (偏移 " + e.offset + ", 行 " + e.line + ", 列 " + e.column + ")");
  } else if (e instanceof ApiError) {
    console.error("错误 [" + e.code + "] " + e.message);
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

const DEMO_SGF = "(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))";
const DEMO_COMMENT = "(;FF[4]C[转义右括号 \\] 双反斜杠 \\\\ 软\\\n换行\n换行保留]N[  名称 \t 规范  ])";

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "serve": {
        const portArg = args.find((a) => a.startsWith("--port="));
        const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0);
        const { port: actual } = await startServer(store, Number.isInteger(port) ? port : 0);
        console.log("API 服务已启动: http://127.0.0.1:" + actual + " (数据库: " + DB_PATH + ")");
        break;
      }
      case "import": {
        const file = args[0];
        if (!file) throw new ApiError("BAD_REQUEST", "用法: cli.ts import <sgf文件>");
        const text = readFileSync(file, "utf8");
        const r = store.importCollection(text);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case "list": {
        for (const g of store.listGames()) {
          console.log("#" + g.id + "  FF[" + g.ff + "]  节点数 " + g.nodeCount + "  " + g.createdAt + "  " + g.hash.slice(0, 12));
        }
        break;
      }
      case "tree": {
        const gameId = Number(args[0]);
        const game = store.getGame(gameId);
        console.log("棋谱 #" + game.id + "  节点数 " + game.nodeCount);
        printTreeFromStore(store, gameId);
        break;
      }
      case "node": {
        const n = store.getNode(Number(args[0]), args[1] ?? ROOT_PATH);
        console.log("路径: " + n.path);
        console.log("到根路径: " + n.pathToRoot.join(" -> "));
        console.log("子分支: " + (n.children.length ? n.children.join(", ") : "(无)"));
        console.log("属性:");
        for (const [k, vs] of Object.entries(n.props)) {
          vs.forEach((v, i) => console.log("  " + k + "[" + i + "] = " + JSON.stringify(v)));
        }
        break;
      }
      case "cursor": {
        const sub = args[0];
        if (sub === "create") {
          console.log(JSON.stringify(store.createCursor(Number(args[1]))));
        } else if (sub === "forward") {
          const branch = args[2] === undefined ? undefined : Number(args[2]);
          console.log(JSON.stringify(store.cursorForward(args[1], branch)));
        } else if (sub === "back") {
          console.log(JSON.stringify(store.cursorBack(args[1])));
        } else if (sub === "show") {
          const s = store.cursorState(args[1]);
          console.log("游标 " + s.cursorId + " 棋谱 #" + s.gameId + " 路径 " + s.path);
          console.log("  " + fmtProps(s.props));
          console.log("  子分支: " + (s.children.length ? s.children.join(", ") : "(无)"));
        } else {
          throw new ApiError("BAD_REQUEST", "用法: cli.ts cursor create|forward|back|show ...");
        }
        break;
      }
      case "export": {
        const out = store.exportGame(Number(args[0]));
        if (args[1]) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(args[1], out, "utf8");
          console.log("已导出到 " + args[1]);
        } else {
          process.stdout.write(out);
        }
        break;
      }
      case "verify": {
        console.log(JSON.stringify(store.verifyGame(Number(args[0]))));
        break;
      }
      case "demo": {
        runDemo(store);
        break;
      }
      default:
        console.log(
          [
            "用法: node src/cli.ts <命令>",
            "  serve [--port=N]     启动 API 服务（默认选择空闲端口）",
            "  import <文件>        导入 SGF 集合（幂等）",
            "  list                 列出棋谱",
            "  tree <gameId>        缩进树展示",
            "  node <gameId> [path] 查询节点（默认 R）",
            "  cursor create <gameId>",
            "  cursor forward <cursorId> [branch]",
            "  cursor back <cursorId>",
            "  cursor show <cursorId>",
            "  export <gameId> [文件] 规范导出",
            "  verify <gameId>      导出-重解析核验",
            "  demo                 运行演示",
          ].join("\n")
        );
    }
  } catch (e) {
    die(e);
  } finally {
    if (cmd !== "serve") store.close();
  }
}

function printTreeFromStore(store: Store, gameId: number): void {
  const walk = (path: string, indent: string): void => {
    const n = store.getNode(gameId, path);
    console.log(indent + path + "  " + fmtProps(n.props));
    n.children.forEach((i) => walk(childPath(path, i), indent + "  "));
  };
  walk(ROOT_PATH, "");
}

function runDemo(store: Store): void {
  console.log("== 演示 1: 共同前缀与两个变化分支 ==");
  console.log("原文: " + DEMO_SGF);
  const r1 = store.importCollection(DEMO_SGF);
  const gid = r1.gameIds[0];
  console.log("导入结果: " + JSON.stringify(r1));
  printTreeFromStore(store, gid);
  const fork = store.getNode(gid, "R.0");
  console.log("分叉点 R.0 (B[aa]) 子分支数: " + fork.children.length);
  const b1 = store.getNode(gid, "R.0.0");
  const b2 = store.getNode(gid, "R.0.1");
  console.log("分支 0: W[bb]，该分支节点数 1（" + JSON.stringify(b1.props) + "）");
  console.log("分支 1: W[cc];B[dd]，该分支节点数 2");
  console.log("到根路径(R.0.1.0): " + store.getNode(gid, "R.0.1.0").pathToRoot.join(" -> "));

  console.log();
  console.log("== 演示 2: 转义右括号、双反斜杠与软换行 ==");
  console.log("原文: " + JSON.stringify(DEMO_COMMENT));
  const r2 = store.importCollection(DEMO_COMMENT);
  const n = store.getNode(r2.gameIds[0], ROOT_PATH);
  console.log("C = " + JSON.stringify(n.props.C[0]));
  console.log("N = " + JSON.stringify(n.props.N[0]));
  console.log("规范导出: " + JSON.stringify(store.exportGame(r2.gameIds[0])));
  console.log("核验: " + JSON.stringify(store.verifyGame(r2.gameIds[0])));
}

main();
