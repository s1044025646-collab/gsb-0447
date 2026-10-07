import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCollection } from '../src/parser.js';
import { exportCollection, validateTree, nodeFromPath, ancestorsOf } from '../src/serializer.js';
import { Store } from '../src/store.js';
import { moveCursor } from '../src/service.js';
import { SgfError } from '../src/errors.js';

const DEMO = '(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))';

test('手写预期树: 共同前缀与两个分支', () => {
  const col = parseCollection(DEMO);
  assert.equal(col.trees.length, 1);
  const root = col.trees[0].root;
  // 根 ;FF[4]GM[1]
  assert.deepEqual(root.props.map((p) => p.name), ['FF', 'GM']);
  assert.deepEqual(root.props[0].values, ['4']);
  // 主线第二节点 B[aa]
  assert.equal(root.children.length, 1);
  const b = root.children[0];
  assert.deepEqual(b.props, [{ name: 'B', values: ['aa'] }]);
  // 分叉点有两个子分支
  assert.equal(b.children.length, 2);
  assert.deepEqual(b.children[0].props, [{ name: 'W', values: ['bb'] }]);
  assert.equal(b.children[0].children.length, 0);
  assert.deepEqual(b.children[1].props, [{ name: 'W', values: ['cc'] }]);
  assert.deepEqual(b.children[1].children[0].props, [{ name: 'B', values: ['dd'] }]);
  assert.equal(col.trees[0].nodeCount, 5);
  // 路径确定
  assert.equal(root.path, '0');
  assert.equal(b.path, '0.0');
  assert.equal(b.children[0].path, '0.0.0');
  assert.equal(b.children[1].path, '0.0.1');
  assert.equal(b.children[1].children[0].path, '0.0.1.0');
  // 祖先链不重复
  const leaf = b.children[1].children[0];
  assert.deepEqual(ancestorsOf(leaf).map((n) => n.path), ['0', '0.0', '0.0.1']);
});

test('转义: 右括号、双反斜杠、软换行、未转义换行归一', () => {
  const col = parseCollection('(;C[a\\]b \\\\ c\\\r\nd\re\nf])');
  assert.equal(col.trees[0].root.props[0].values[0], 'a]b \\ cd\ne\nf');
});

test('N 按 SimpleText 规范空白, 未知属性保留原样', () => {
  const col = parseCollection('(;N[  a\t b\n  c ]XX[  q  \n r ])');
  const props = col.trees[0].root.props;
  assert.equal(props.find((p) => p.name === 'N')!.values[0], 'a b c');
  assert.equal(props.find((p) => p.name === 'XX')!.values[0], '  q  \n r ');
});

test('多棋谱集合 / 多值属性 / 空值 / 值内结构字符', () => {
  const col = parseCollection('(;FF[4])(;AB[aa][bb][]C[x;y(z):w])');
  assert.equal(col.trees.length, 2);
  const ab = col.trees[1].root.props.find((p) => p.name === 'AB')!;
  assert.deepEqual(ab.values, ['aa', 'bb', '']);
  const c = col.trees[1].root.props.find((p) => p.name === 'C')!;
  assert.equal(c.values[0], 'x;y(z):w');
});

test('中文码点位置报错', () => {
  try {
    parseCollection('(;FF[4])甲乙丙');
    assert.fail('should throw');
  } catch (e) {
    const err = e as SgfError;
    assert.equal(err.code, 'PARSE_TRAILING_GARBAGE');
    assert.equal(err.pos, 8); // 码点位置, 不是 UTF-16 单元之外的其他计数
    assert.equal(err.line, 1);
    assert.equal(err.col, 9);
  }
});

test('非法语法: 未闭合值/空树/重复属性/多余字符/缺属性名', () => {
  assert.throws(() => parseCollection('(;C[abc'), /unclosed/);
  assert.throws(() => parseCollection('()'), (e) => (e as SgfError).code === 'PARSE_EMPTY_TREE');
  assert.throws(() => parseCollection('(;B[aa]B[bb])'), (e) => (e as SgfError).code === 'PARSE_DUPLICATE_PROP');
  assert.throws(() => parseCollection('(;B[aa]) xx'), (e) => (e as SgfError).code === 'PARSE_TRAILING_GARBAGE');
  assert.throws(() => parseCollection('(;[aa])'), (e) => (e as SgfError).code === 'PARSE_MISSING_PROP_NAME');
  assert.throws(() => parseCollection('(;b[aa])'), (e) => (e as SgfError).code === 'PARSE_INVALID_IDENT');
});

test('导出稳定且结构等价(往返)', () => {
  const src = '(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]C[a\\]b]))(;FF[4]N[x y])';
  const col = parseCollection(src);
  const out1 = exportCollection(col);
  const out2 = exportCollection(parseCollection(out1));
  assert.equal(out1, out2);
});

test('树校验: 无环且每个节点仅一个父节点', () => {
  const col = parseCollection(DEMO);
  assert.deepEqual(validateTree(col.trees[0].root), []);
});

function tmpStore() {
  return new Store(mkdtempSync(path.join(tmpdir(), 'sgf-')));
}

test('游标: 分叉必须显式选择, 退回父节点, 游标独立', () => {
  const store = tmpStore();
  const { trees } = store.importCollection(DEMO);
  const c1 = store.createCursor(trees[0].id);
  const c2 = store.createCursor(trees[0].id);
  let r = moveCursor(store, c1.id, 'forward');
  assert.equal(r.path, '0.0');
  assert.throws(() => moveCursor(store, c1.id, 'forward'), (e) => (e as SgfError).code === 'MUST_CHOOSE_BRANCH');
  r = moveCursor(store, c1.id, 'choose', 1);
  assert.equal(r.path, '0.0.1');
  r = moveCursor(store, c1.id, 'back');
  assert.equal(r.path, '0.0');
  // c2 未受影响
  assert.equal(store.getCursor(c2.id).path, '0');
  store.close();
});

test('幂等导入与重启后游标一致', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sgf-'));
  let store = new Store(dir);
  const r1 = store.importCollection(DEMO, 'key-1');
  const r2 = store.importCollection(DEMO, 'key-1');
  assert.equal(r2.reused, true);
  assert.deepEqual(r2.trees.map((t) => t.id), r1.trees.map((t) => t.id));
  // 修改文本 -> 新棋谱
  const r3 = store.importCollection(DEMO.replace('W[bb]', 'W[ee]'), 'key-2');
  assert.notEqual(r3.trees[0].id, r1.trees[0].id);
  const cursor = store.createCursor(r1.trees[0].id);
  moveCursor(store, cursor.id, 'forward');
  store.close();
  // 重启
  store = new Store(dir);
  assert.equal(store.getCursor(cursor.id).path, '0.0');
  const v = store.verifyTree(r1.trees[0].id);
  assert.equal(v.ok, true);
  store.close();
});

test('导入失败不留半棵树', () => {
  const store = tmpStore();
  assert.throws(() => store.importCollection('(;FF[4])(;B[aa'), /unclosed/);
  assert.equal(store.listTrees().length, 0);
  store.close();
});

test('nodeFromPath 非法路径返回 null', () => {
  const col = parseCollection(DEMO);
  assert.equal(nodeFromPath(col.trees[0].root, '0.9'), null);
  assert.equal(nodeFromPath(col.trees[0].root, 'x.y'), null);
});
