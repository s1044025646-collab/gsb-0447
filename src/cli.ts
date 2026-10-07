#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { createServer } from './server.js';
import { moveCursor, nodeInfo, renderBranch, renderTree, treeSummary, MoveOp } from './service.js';
import { SgfError } from './errors.js';

const DATA_DIR = process.env.SGF_DATA_DIR ?? path.join(process.cwd(), 'data');

function usage(): never {
  console.log(`SGF 变化树服务 CLI
用法: sgf <命令> [参数]
  serve [--port N]                 启动 HTTP API（默认端口 0，自动选空闲端口）
  import <文件> [--key K]          导入 SGF 集合（UTF-8）
  list                             列出棋谱
  show <treeId>                    缩进树展示
  node <treeId> <path>             查询节点属性
  branch <treeId> [path]           打印从 path 起的主线分支
  export <treeId>                  规范导出 SGF
  verify <treeId>                  导出并重新导入核验
  cursor-new <treeId>              创建游标
  cursor-show <cursorId>           查看游标
  move <cursorId> <forward|back|choose|root> [branch]
  demo                             运行内置演示`);
  process.exit(1);
}

function fail(e: unknown): never {
  if (e instanceof SgfError) {
    console.error(JSON.stringify({ error: e.toJSON() }, null, 2));
  } else {
    console.error(e);
  }
  process.exit(1);
}

function demo(store: Store) {
  const text = '(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))';
  const { trees, collection } = store.importCollection(text, 'demo-basic');
  const tree = collection.trees[0];
  console.log('== 演示 1: 共同前缀与两个分支 ==');
  console.log('原文:', text);
  console.log(renderTree(tree));
  const root = tree.root;
  const bNode = root.children[0];
  console.log(`共同前缀节点数(根+B): 2, 分叉点: ${bNode.path}`);
  bNode.children.forEach((c, i) => {
    let n = 0;
    let cur: typeof c | null = c;
    while (cur) { n++; cur = cur.children[0] ?? null; }
    console.log(`分支 ${i} (${c.path}): 节点数 ${n}`);
  });
  console.log('树ID:', trees[0].id);

  const esc = '(;FF[4]C[comment with \\] bracket and \\\\ backslash\\\nsoft join];N[  a\t b\n c ])';
  const r2 = store.importCollection(esc, 'demo-escape');
  const t2 = r2.collection.trees[0];
  console.log('\n== 演示 2: 转义右括号 / 双反斜杠 / 软换行 ==');
  console.log('原文:', JSON.stringify(esc));
  console.log('C =', JSON.stringify(t2.root.props.find((p) => p.name === 'C')?.values[0]));
  console.log('N =', JSON.stringify(t2.root.children[0]?.props.find((p) => p.name === 'N')?.values[0]));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();
  const store = new Store(DATA_DIR);
  try {
    switch (cmd) {
      case 'serve': {
        const portIdx = args.indexOf('--port');
        const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : (parseInt(process.env.PORT ?? '', 10) || 0);
        const server = createServer(store);
        server.listen(port, () => {
          const addr = server.address();
          console.log(`SGF API listening on http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`);
        });
        return; // keep process alive
      }
      case 'import': {
        const file = args[0];
        if (!file) usage();
        const keyIdx = args.indexOf('--key');
        const key = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
        const text = readFileSync(file, 'utf8');
        const result = store.importCollection(text, key);
        console.log(JSON.stringify({ reused: result.reused, trees: result.trees }, null, 2));
        break;
      }
      case 'list':
        console.log(JSON.stringify(store.listTrees(), null, 2));
        break;
      case 'show': {
        const tree = store.loadTree(args[0]);
        console.log(renderTree(tree));
        console.log(JSON.stringify(treeSummary(tree)));
        break;
      }
      case 'node':
        console.log(JSON.stringify(nodeInfo(store.loadTree(args[0]), args[1] ?? '0'), null, 2));
        break;
      case 'branch':
        console.log(renderBranch(store.loadTree(args[0]), args[1] ?? '0'));
        break;
      case 'export':
        console.log(store.exportTree(args[0]));
        break;
      case 'verify':
        console.log(JSON.stringify(store.verifyTree(args[0])));
        break;
      case 'cursor-new':
        console.log(JSON.stringify(store.createCursor(args[0])));
        break;
      case 'cursor-show':
        console.log(JSON.stringify(store.getCursor(args[0])));
        break;
      case 'move': {
        const op = args[1] as MoveOp;
        const branch = args[2] !== undefined ? parseInt(args[2], 10) : undefined;
        console.log(JSON.stringify(moveCursor(store, args[0], op, branch), null, 2));
        break;
      }
      case 'demo':
        demo(store);
        break;
      default:
        usage();
    }
  } catch (e) {
    fail(e);
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

main();
