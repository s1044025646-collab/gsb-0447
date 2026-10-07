import { Collection, GameTree, SgfNode, PropEntry, LIMITS } from './model.js';
import { SgfError } from './errors.js';

const SIMPLE_TEXT_PROPS = new Set(['N']);

function isUpperAZ(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

function normalizeSimpleText(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

class Parser {
  private cps: string[];
  private i = 0;
  private line = 1;
  private col = 1;
  private nodeCount = 0;
  private nextNodeId = 0;

  constructor(text: string) {
    if (text.length > LIMITS.MAX_TEXT_LENGTH) {
      throw new SgfError('LIMIT_TEXT_LENGTH', `text length ${text.length} exceeds limit ${LIMITS.MAX_TEXT_LENGTH}`);
    }
    this.cps = Array.from(text);
  }

  private peek(): string | undefined {
    return this.cps[this.i];
  }

  private next(): string | undefined {
    const ch = this.cps[this.i];
    if (ch === undefined) return undefined;
    this.i++;
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private err(code: SgfError['code'], msg: string): SgfError {
    return new SgfError(code, msg, this.i, this.line, this.col);
  }

  private skipWs(): void {
    while (this.peek() !== undefined && /\s/u.test(this.peek()!)) this.next();
  }

  parseCollection(): Collection {
    const trees: GameTree[] = [];
    this.skipWs();
    while (this.peek() === '(') {
      trees.push(this.parseGameTree(1));
      this.skipWs();
    }
    if (this.peek() !== undefined) {
      throw this.err('PARSE_TRAILING_GARBAGE', `unexpected character '${this.peek()}' after collection`);
    }
    if (trees.length === 0) {
      throw this.err('PARSE_EXPECTED', 'collection contains no game tree');
    }
    return { trees };
  }

  private parseGameTree(depth: number): GameTree {
    if (depth > LIMITS.MAX_DEPTH) {
      throw this.err('LIMIT_DEPTH', `nesting depth exceeds limit ${LIMITS.MAX_DEPTH}`);
    }
    this.next(); // consume '('
    this.skipWs();
    if (this.peek() !== ';') {
      throw this.err('PARSE_EMPTY_TREE', 'game tree must start with a node (semicolon)');
    }
    // sequence of nodes
    let first: SgfNode | null = null;
    let last: SgfNode | null = null;
    while (this.peek() === ';') {
      const node = this.parseNode();
      if (last) {
        node.parent = last;
        last.children.push(node);
      }
      if (!first) first = node;
      last = node;
    }
    // subtrees attach to last node of the sequence
    this.skipWs();
    while (this.peek() === '(') {
      const sub = this.parseGameTree(depth + 1);
      sub.root.parent = last;
      last!.children.push(sub.root);
      this.skipWs();
    }
    if (this.peek() !== ')') {
      throw this.err('PARSE_EXPECTED', `expected ')' to close game tree, got '${this.peek() ?? 'EOF'}'`);
    }
    this.next(); // consume ')'
    const count = this.countNodes(first!);
    return { root: first!, nodeCount: count, maxDepth: depth };
  }

  private countNodes(root: SgfNode): number {
    let n = 0;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      n++;
      for (const c of node.children) stack.push(c);
    }
    return n;
  }

  private parseNode(): SgfNode {
    this.next(); // consume ';'
    this.nodeCount++;
    if (this.nodeCount > LIMITS.MAX_NODES) {
      throw this.err('LIMIT_NODE_COUNT', `node count exceeds limit ${LIMITS.MAX_NODES}`);
    }
    const node: SgfNode = {
      id: this.nextNodeId++,
      parent: null,
      children: [],
      props: [],
      path: '',
    };
    const seen = new Set<string>();
    for (;;) {
      this.skipWs();
      const ch = this.peek();
      if (ch === '[') {
        throw this.err('PARSE_MISSING_PROP_NAME', 'property value without a property name');
      }
      if (/[a-z]/u.test(ch!)) {
        throw this.err('PARSE_INVALID_IDENT', `property name must be uppercase ASCII letters, got '${ch}'`);
      }
      if (ch === undefined || !isUpperAZ(ch)) break;
      const prop = this.parseProperty();
      if (seen.has(prop.name)) {
        throw this.err('PARSE_DUPLICATE_PROP', `duplicate property '${prop.name}' in one node`);
      }
      seen.add(prop.name);
      node.props.push(prop);
    }
    return node;
  }

  private parseProperty(): PropEntry {
    let name = '';
    while (this.peek() !== undefined && isUpperAZ(this.peek()!)) {
      name += this.next();
    }
    this.skipWs();
    if (this.peek() !== '[') {
      throw this.err('PARSE_MISSING_PROP_NAME', `property '${name}' has no value (expected '[')`);
    }
    const values: string[] = [];
    while (this.peek() === '[') {
      values.push(this.parseValue(name));
      this.skipWs();
    }
    return { name, values };
  }

  private parseValue(propName: string): string {
    this.next(); // consume '['
    const out: string[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === undefined) {
        throw this.err('PARSE_UNCLOSED_VALUE', "unclosed property value (missing ']')");
      }
      if (ch === ']') {
        this.next();
        break;
      }
      if (ch === '\\') {
        this.next();
        const esc = this.peek();
        if (esc === undefined) {
          throw this.err('PARSE_DANGLING_ESCAPE', 'dangling backslash at end of value');
        }
        if (esc === '\r') {
          this.next();
          if (this.peek() === '\n') this.next();
          continue; // soft newline
        }
        if (esc === '\n') {
          this.next();
          continue; // soft newline
        }
        // any other escaped char: drop backslash, keep char
        out.push(this.next()!);
        continue;
      }
      if (ch === '\r') {
        this.next();
        if (this.peek() === '\n') this.next();
        out.push('\n');
        continue;
      }
      out.push(this.next()!);
    }
    let value = out.join('');
    if (SIMPLE_TEXT_PROPS.has(propName)) {
      value = normalizeSimpleText(value);
    }
    return value;
  }
}

function assignPaths(root: SgfNode): void {
  root.path = '0';
  const walk = (node: SgfNode) => {
    node.children.forEach((child, idx) => {
      child.path = `${node.path}.${idx}`;
      walk(child);
    });
  };
  walk(root);
}

export function parseCollection(text: string): Collection {
  const col = new Parser(text).parseCollection();
  for (const tree of col.trees) assignPaths(tree.root);
  return col;
}
