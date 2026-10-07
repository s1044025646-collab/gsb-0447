import { GameTree, SgfNode } from './model.js';
import { SgfError } from './errors.js';
import { ancestorsOf, mainlineLength, nodeFromPath } from './serializer.js';
import { Store } from './store.js';

export function nodeInfo(tree: GameTree, path: string) {
  const node = nodeFromPath(tree.root, path);
  if (!node) throw new SgfError('NOT_FOUND', `no node at path '${path}'`);
  return describeNode(node);
}

export function describeNode(node: SgfNode) {
  return {
    path: node.path,
    props: node.props.map((p) => ({ name: p.name, values: p.values })),
    childCount: node.children.length,
    children: node.children.map((c) => c.path),
    parent: node.parent ? node.parent.path : null,
    ancestors: ancestorsOf(node).map((a) => a.path),
  };
}

export type MoveOp = 'forward' | 'back' | 'choose' | 'root';

export function moveCursor(store: Store, cursorId: string, op: MoveOp, branch?: number) {
  const cursor = store.getCursor(cursorId);
  const tree = store.loadTree(cursor.treeId);
  const node = nodeFromPath(tree.root, cursor.path);
  if (!node) throw new SgfError('NOT_FOUND', `cursor path '${cursor.path}' no longer exists`);
  let target: SgfNode;
  switch (op) {
    case 'root':
      target = tree.root;
      break;
    case 'back':
      if (!node.parent) throw new SgfError('NO_PARENT', 'already at root node');
      target = node.parent;
      break;
    case 'forward': {
      if (node.children.length === 0) throw new SgfError('NO_CHILD', 'node has no child to move to');
      if (node.children.length > 1) {
        throw new SgfError('MUST_CHOOSE_BRANCH', `node has ${node.children.length} branches; use choose with branch index 0..${node.children.length - 1}`);
      }
      target = node.children[0];
      break;
    }
    case 'choose': {
      if (branch === undefined || !Number.isInteger(branch)) {
        throw new SgfError('VALIDATION', 'choose requires an integer branch index');
      }
      if (branch < 0 || branch >= node.children.length) {
        throw new SgfError('VALIDATION', `branch index ${branch} out of range 0..${node.children.length - 1}`);
      }
      target = node.children[branch];
      break;
    }
  }
  store.setCursorPath(cursorId, target.path);
  return { cursorId, path: target.path, node: describeNode(target) };
}

export function treeSummary(tree: GameTree) {
  return {
    nodeCount: tree.nodeCount,
    mainlineLength: mainlineLength(tree.root),
  };
}

export function renderTree(tree: GameTree): string {
  const lines: string[] = [];
  const fmtProps = (n: SgfNode) =>
    n.props.map((p) => `${p.name}[${p.values.join('][')}]`).join(' ');
  const walk = (node: SgfNode, depth: number, isMainline: boolean) => {
    const tag = isMainline ? '*' : '-';
    lines.push(`${'  '.repeat(depth)}${tag} ${node.path} ${fmtProps(node)}`);
    node.children.forEach((c, i) => walk(c, depth + (i === 0 ? 0 : 1), i === 0 && isMainline));
  };
  walk(tree.root, 0, true);
  return lines.join('\n');
}

export function renderBranch(tree: GameTree, path: string): string {
  const node = nodeFromPath(tree.root, path);
  if (!node) throw new SgfError('NOT_FOUND', `no node at path '${path}'`);
  const lines: string[] = [];
  let cur: SgfNode | null = node;
  while (cur) {
    lines.push(`${cur.path}: ${cur.props.map((p) => `${p.name}=${JSON.stringify(p.values)}`).join(' ')}`);
    if (cur.children.length > 1) {
      lines.push(`  -> branches: ${cur.children.map((c) => c.path).join(', ')}`);
    }
    cur = cur.children[0] ?? null;
  }
  return lines.join('\n');
}
