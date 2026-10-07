import { Collection, GameTree, SgfNode } from './model.js';

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function serializeNode(node: SgfNode): string {
  let s = ';';
  for (const prop of node.props) {
    s += prop.name;
    for (const v of prop.values) s += `[${escapeValue(v)}]`;
  }
  return s;
}

function serializeTreeFrom(node: SgfNode): string {
  let out = '(';
  let cur: SgfNode | null = node;
  while (cur) {
    out += serializeNode(cur);
    if (cur.children.length === 1) {
      cur = cur.children[0];
    } else {
      for (const v of cur.children) out += serializeTreeFrom(v);
      cur = null;
    }
  }
  out += ')';
  return out;
}

export function exportCollection(col: Collection): string {
  return col.trees.map((t) => serializeTreeFrom(t.root)).join('\n');
}

export function treeToJSON(root: SgfNode): unknown {
  return {
    path: root.path,
    props: root.props.map((p) => ({ name: p.name, values: p.values })),
    children: root.children.map(treeToJSON),
  };
}

export function treeFromJSON(data: any): SgfNode {
  const build = (d: any, parent: SgfNode | null): SgfNode => {
    const node: SgfNode = {
      id: 0,
      parent,
      children: [],
      props: (d.props ?? []).map((p: any) => ({ name: p.name, values: [...p.values] })),
      path: d.path,
    };
    node.children = (d.children ?? []).map((c: any) => build(c, node));
    return node;
  };
  return build(data, null);
}

export function nodeFromPath(root: SgfNode, path: string): SgfNode | null {
  const parts = path.split('.').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  let cur: SgfNode | null = root;
  for (let i = 1; i < parts.length; i++) {
    cur = cur?.children[parts[i]] ?? null;
    if (!cur) return null;
  }
  return cur;
}

export function ancestorsOf(node: SgfNode): SgfNode[] {
  const out: SgfNode[] = [];
  let cur = node.parent;
  while (cur) {
    out.unshift(cur);
    cur = cur.parent;
  }
  return out;
}

export function mainlineLength(root: SgfNode): number {
  let n = 0;
  let cur: SgfNode | null = root;
  while (cur) {
    n++;
    cur = cur.children[0] ?? null;
  }
  return n;
}

export function validateTree(root: SgfNode): string[] {
  const problems: string[] = [];
  const seen = new Set<SgfNode>();
  const walk = (node: SgfNode, parent: SgfNode | null) => {
    if (seen.has(node)) {
      problems.push(`cycle or shared node at ${node.path}`);
      return;
    }
    seen.add(node);
    if (node.parent !== parent) problems.push(`bad parent link at ${node.path}`);
    node.children.forEach((c, i) => {
      if (c.parent !== node) problems.push(`node ${c.path} has wrong parent`);
      walk(c, node);
    });
  };
  walk(root, null);
  return problems;
}
