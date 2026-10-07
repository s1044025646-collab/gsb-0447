import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCollection, serializeCollection, structurallyEqual, SgfError,
  getNodeAtPath, pathToRoot, countNodes,
} from "../src/sgf.ts";
import type { SgfNode } from "../src/sgf.ts";
import { Store, ApiError } from "../src/store.ts";

test("手写预期树：共同前缀与两个分支", () => {
  const roots = parseCollection("(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))");
  const expected: SgfNode = {
    props: { FF: ["4"], GM: ["1"] },
    children: [
      {
        props: { B: ["aa"] },
        children: [
          { props: { W: ["bb"] }, children: [] },
          {
            props: { W: ["cc"] },
            children: [{ props: { B: ["dd"] }, children: [] }],
          },
        ],
      },
    ],
  };
  assert.equal(roots.length, 1);
  assert.ok(structurallyEqual(roots[0], expected));
  assert.equal(countNodes(roots[0]), 5);
});

test("多棋谱集合", () => {
  const roots = parseCollection("(;FF[4];B[aa])(;FF[4]GM[1];W[bb])");
  assert.equal(roots.length, 2);
  assert.deepEqual(roots[0].props, { FF: ["4"] });
  assert.deepEqual(roots[1].props, { FF: ["4"], GM: ["1"] });
});

test("多值属性保持顺序，不产生额外节点", () => {
  const roots = parseCollection("(;FF[4]AB[aa][bb][cc];B[dd])");
  assert.deepEqual(roots[0].props.AB, ["aa", "bb", "cc"]);
  assert.equal(roots[0].children.length, 1);
  assert.equal(countNodes(roots[0]), 2);
});

test("未知属性原样保留，空值允许", () => {
  const roots = parseCollection("(;FF[4]XX[  a  b  ][x]C[])");
  assert.deepEqual(roots[0].props.XX, ["  a  b  ", "x"]);
  assert.deepEqual(roots[0].props.C, [""]);
});

test("值内分号、括号、冒号不是结构标记", () => {
  const roots = parseCollection("(;C[a;b(c):d];B[aa])");
  assert.equal(roots[0].props.C[0], "a;b(c):d");
  assert.equal(countNodes(roots[0]), 2);
});

test("转义：反斜杠右括号与双反斜杠", () => {
  const roots = parseCollection("(;C[a\\]b\\\\c])");
  assert.equal(roots[0].props.C[0], "a]b\\c");
});

test("软换行：反斜杠 + LF / CRLF / CR 整体删除", () => {
  assert.equal(parseCollection("(;C[a\\\nb])")[0].props.C[0], "ab");
  assert.equal(parseCollection("(;C[a\\\r\nb])")[0].props.C[0], "ab");
  assert.equal(parseCollection("(;C[a\\\rb])")[0].props.C[0], "ab");
});

test("其他被转义字符去反斜杠保留", () => {
  assert.equal(parseCollection("(;C[\\n\\t\\[])")[0].props.C[0], "nt[");
});

test("未转义换行统一为 LF；C 保留换行", () => {
  assert.equal(parseCollection("(;C[a\r\nb\rc\nd])")[0].props.C[0], "a\nb\nc\nd");
});

test("N 按 SimpleText 规范空白", () => {
  assert.equal(parseCollection("(;N[  甲 \t 乙\n 丙  ])")[0].props.N[0], "甲 乙 丙");
});

test("B/W 只保留解码值", () => {
  const roots = parseCollection("(;B[aa]W[bb])");
  assert.deepEqual(roots[0].props.B, ["aa"]);
  assert.deepEqual(roots[0].props.W, ["bb"]);
});

function expectErr(code: string, text: string): SgfError {
  try {
    parseCollection(text);
  } catch (e) {
    assert.ok(e instanceof SgfError);
    assert.equal((e as SgfError).code, code, "期望错误码 " + code + "，实际 " + (e as SgfError).code);
    return e as SgfError;
  }
  assert.fail("应抛出 " + code);
}

test("未闭合值", () => { expectErr("SGF_UNCLOSED_VALUE", "(;C[abc)"); });
test("悬空反斜杠", () => { expectErr("SGF_DANGLING_BACKSLASH", "(;C[ab\\"); });
test("空树", () => { expectErr("SGF_EMPTY_TREE", "()"); });
test("值前缺属性名", () => { expectErr("SGF_MISSING_PROP_IDENT", "(;[aa])"); });
test("集合后多余字符", () => { expectErr("SGF_TRAILING_GARBAGE", "(;FF[4]) xx"); });
test("重复属性名", () => { expectErr("SGF_DUPLICATE_PROPERTY", "(;B[aa]B[bb])"); });
test("小写属性名非法", () => { expectErr("SGF_BAD_PROP_NAME", "(;Ff[4])"); });
test("空集合", () => { expectErr("SGF_EMPTY_COLLECTION", "  \n "); });

test("中文码点位置：偏移按码点计", () => {
  const text = "(;C[甲乙]N[丙];[x])";
  const e = expectErr("SGF_MISSING_PROP_IDENT", text);
  const chars = Array.from(text);
  assert.equal(chars[e.offset], "[");
  assert.equal(e.column, e.offset + 1);
  assert.equal(e.line, 1);
});

test("行列：跨行报错位置", () => {
  const text = "(;FF[4]\n;B[aa]\n;C[abc)";
  const e = expectErr("SGF_UNCLOSED_VALUE", text);
  assert.equal(e.line, 3);
});

test("限制：文本长度 / 节点数 / 深度", () => {
  assert.throws(() => parseCollection("(;FF[4])", { maxTextLength: 3, maxNodes: 100, maxDepth: 100 }), /超过限制/);
  assert.throws(() => parseCollection("(;FF[4];B[aa];W[bb])", { maxTextLength: 100, maxNodes: 2, maxDepth: 100 }), /节点数/);
  const deep = "(;FF[4]" + "(;B[aa]".repeat(50) + ")".repeat(51);
  assert.throws(() => parseCollection(deep, { maxTextLength: 1e6, maxNodes: 100, maxDepth: 10 }), /深度/);
});

test("路径与到根祖先链", () => {
  const roots = parseCollection("(;FF[4];B[aa](;W[bb])(;W[cc];B[dd]))");
  assert.ok(getNodeAtPath(roots[0], "R.0.1.0"));
  assert.deepEqual(pathToRoot("R.0.1.0"), ["R", "R.0", "R.0.1", "R.0.1.0"]);
  assert.equal(getNodeAtPath(roots[0], "R.9"), null);
});

test("导出稳定且重解析等价", () => {
  const text = "(;FF[4]GM[1]C[a\\]b\\\\\n多行];B[aa](;W[bb]XX[ 怪 值 ])(;W[cc];B[dd]N[ x ]))";
  const roots = parseCollection(text);
  const out1 = serializeCollection(roots);
  const out2 = serializeCollection(parseCollection(out1));
  assert.equal(out1, out2, "导出应确定稳定");
  assert.ok(structurallyEqual(roots[0], parseCollection(out1)[0]), "重解析应结构等价");
});

test("父子关系：无环且每节点仅一个父节点", () => {
  const roots = parseCollection("(;FF[4];B[aa](;W[bb])(;W[cc];B[dd](;C[x])(;C[y])))");
  const parents = new Map<SgfNode, SgfNode>();
  const seen = new Set<SgfNode>();
  const walk = (n: SgfNode): void => {
    assert.ok(!seen.has(n), "节点被重复引用（环或多父）");
    seen.add(n);
    for (const c of n.children) {
      assert.ok(!parents.has(c));
      parents.set(c, n);
      walk(c);
    }
  };
  walk(roots[0]);
  assert.equal(parents.size, countNodes(roots[0]) - 1);
});

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sgf-test-"));
  return { path: join(dir, "t.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("导入幂等：重复提交返回原结果，修改文本产生新棋谱", () => {
  const { path, cleanup } = tempDb();
  const store = new Store(path);
  const r1 = store.importCollection("(;FF[4];B[aa])");
  const r2 = store.importCollection("(;FF[4];B[aa])");
  assert.equal(r2.duplicate, true);
  assert.deepEqual(r2.gameIds, r1.gameIds);
  const r3 = store.importCollection("(;FF[4];B[bb])");
  assert.notDeepEqual(r3.gameIds, r1.gameIds);
  assert.equal(store.listGames().length, 2);
  store.close();
  cleanup();
});

test("导入失败不留半棵树", () => {
  const { path, cleanup } = tempDb();
  const store = new Store(path);
  assert.throws(() => store.importCollection("(;FF[4];B[aa])(;C[未闭合)"));
  assert.equal(store.listGames().length, 0);
  store.close();
  cleanup();
});

test("游标：分支必须显式选择、退回父节点、游标互相独立", () => {
  const { path, cleanup } = tempDb();
  const store = new Store(path);
  const { gameIds } = store.importCollection("(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))");
  const gid = gameIds[0];
  const c1 = store.createCursor(gid).cursorId;
  const c2 = store.createCursor(gid).cursorId;
  store.cursorForward(c1);
  assert.throws(() => store.cursorForward(c1), (e: unknown) => e instanceof ApiError && (e as ApiError).code === "BRANCH_REQUIRED");
  store.cursorForward(c1, 1);
  assert.equal(store.cursorState(c1).path, "R.0.1");
  assert.equal(store.cursorState(c2).path, "R", "移动 c1 不应影响 c2");
  store.cursorForward(c1);
  assert.equal(store.cursorState(c1).path, "R.0.1.0");
  assert.throws(() => store.cursorForward(c1), (e: unknown) => (e as ApiError).code === "NO_CHILD");
  store.cursorBack(c1);
  store.cursorBack(c1);
  assert.equal(store.cursorState(c1).path, "R.0");
  store.cursorBack(c1);
  assert.throws(() => store.cursorBack(c1), (e: unknown) => (e as ApiError).code === "AT_ROOT");
  assert.throws(() => store.cursorForward(c1, 5), (e: unknown) => (e as ApiError).code === "BRANCH_OUT_OF_RANGE");
  store.close();
  cleanup();
});

test("重启后游标一致", () => {
  const { path, cleanup } = tempDb();
  let store = new Store(path);
  const { gameIds } = store.importCollection("(;FF[4];B[aa](;W[bb])(;W[cc]))");
  const cid = store.createCursor(gameIds[0]).cursorId;
  store.cursorForward(cid);
  store.cursorForward(cid, 1);
  store.close();
  store = new Store(path);
  const s = store.cursorState(cid);
  assert.equal(s.path, "R.0.1");
  assert.deepEqual(s.props, { W: ["cc"] });
  store.close();
  cleanup();
});

test("核验与导出", () => {
  const { path, cleanup } = tempDb();
  const store = new Store(path);
  const { gameIds } = store.importCollection("(;FF[4]C[a\\]b];B[aa](;W[bb])(;W[cc]))");
  assert.equal(store.verifyGame(gameIds[0]).ok, true);
  const out = store.exportGame(gameIds[0]);
  assert.ok(out.includes("C[a\\]b]"));
  store.close();
  cleanup();
});
