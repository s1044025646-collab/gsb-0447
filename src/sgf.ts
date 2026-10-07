// SGF FF[4] 结构解析与确定性导出。
// 只处理 Collection / GameTree / Sequence / Node / Property 的嵌套语法，
// 不执行任何围棋规则。

export interface SgfNode {
  /** 属性名 -> 有序值列表（值已按规范解码） */
  props: Record<string, string[]>;
  /** 子节点；children[0] 为主线延续，其余为变化分支 */
  children: SgfNode[];
}

export interface ParseLimits {
  maxTextLength: number;
  maxNodes: number;
  maxDepth: number;
}

export const DEFAULT_LIMITS: ParseLimits = {
  maxTextLength: 1000000,
  maxNodes: 100000,
  maxDepth: 1000,
};

export type SgfErrorCode =
  | "SGF_UNCLOSED_VALUE"
  | "SGF_DANGLING_BACKSLASH"
  | "SGF_EMPTY_TREE"
  | "SGF_MISSING_PROP_IDENT"
  | "SGF_BAD_PROP_NAME"
  | "SGF_DUPLICATE_PROPERTY"
  | "SGF_TRAILING_GARBAGE"
  | "SGF_UNEXPECTED_CHAR"
  | "SGF_EMPTY_COLLECTION"
  | "SGF_LIMIT_EXCEEDED";

export class SgfError extends Error {
  code: SgfErrorCode;
  offset: number;
  line: number;
  column: number;
  constructor(code: SgfErrorCode, message: string, offset: number, line: number, column: number) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
  toJSON() {
    return { code: this.code, message: this.message, offset: this.offset, line: this.line, column: this.column };
  }
}

const isWs = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
const isUpper = (c: string): boolean => c >= "A" && c <= "Z";

/** SimpleText 类型（如 N）：所有空白规范为单个空格。 */
function coerceSimpleText(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

function coerceValue(prop: string, v: string): string {
  if (prop === "C") return v; // Text：保留换行（已统一为 LF）
  if (prop === "N") return coerceSimpleText(v);
  // B、W 与未知属性：保留解码后的字符，不猜测类型、不改写空白。
  return v;
}

class Parser {
  private chars: string[];
  private i = 0;
  private nodes = 0;
  private text: string;
  private limits: ParseLimits;
  constructor(text: string, limits: ParseLimits) {
    this.text = text;
    this.limits = limits;
    this.chars = Array.from(text);
    if (this.chars.length > limits.maxTextLength) {
      throw this.err("SGF_LIMIT_EXCEEDED", "文本长度 " + this.chars.length + " 超过限制 " + limits.maxTextLength, 0);
    }
  }

  private pos(offset: number): { line: number; col: number } {
    let line = 1;
    let col = 1;
    for (let k = 0; k < offset; k++) {
      const c = this.chars[k];
      if (c === "\r") {
        if (this.chars[k + 1] === "\n" && k + 1 < offset) k++;
        line++;
        col = 1;
      } else if (c === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, col };
  }

  private err(code: SgfErrorCode, message: string, offset: number): SgfError {
    const p = this.pos(offset);
    return new SgfError(code, message, offset, p.line, p.col);
  }

  private peek(): string | undefined {
    return this.chars[this.i];
  }

  private skipWs(): void {
    while (this.i < this.chars.length && isWs(this.chars[this.i])) this.i++;
  }

  parseCollection(): SgfNode[] {
    const roots: SgfNode[] = [];
    this.skipWs();
    while (this.i < this.chars.length) {
      if (this.peek() !== "(") {
        if (roots.length > 0) {
          throw this.err("SGF_TRAILING_GARBAGE", "集合结束后存在多余字符 '" + this.peek() + "'", this.i);
        }
        throw this.err("SGF_UNEXPECTED_CHAR", "集合中期望 '('，得到 '" + this.peek() + "'", this.i);
      }
      roots.push(this.parseTree(1));
      this.skipWs();
    }
    if (roots.length === 0) {
      throw this.err("SGF_EMPTY_COLLECTION", "集合为空：至少需要一棵棋谱树", 0);
    }
    return roots;
  }

  private parseTree(depth: number): SgfNode {
    if (depth > this.limits.maxDepth) {
      throw this.err("SGF_LIMIT_EXCEEDED", "嵌套深度超过限制 " + this.limits.maxDepth, this.i);
    }
    const open = this.i;
    this.i++;
    this.skipWs();
    if (this.peek() !== ";") {
      if (this.peek() === ")") throw this.err("SGF_EMPTY_TREE", "空树：括号内至少需要一个节点", open);
      throw this.err("SGF_UNEXPECTED_CHAR", "树必须以节点序列（';'）开始", this.i);
    }
    let first: SgfNode | null = null;
    let last: SgfNode | null = null;
    while (this.peek() === ";") {
      const node = this.parseNode();
      if (!first) first = node;
      else last!.children.push(node);
      last = node;
      this.skipWs();
    }
    while (this.peek() === "(") {
      const child = this.parseTree(depth + 1);
      last!.children.push(child);
      this.skipWs();
    }
    if (this.peek() !== ")") {
      throw this.err("SGF_UNEXPECTED_CHAR", "期望 ')' 或子树，得到 '" + (this.peek() ?? "EOF") + "'", this.i);
    }
    this.i++;
    return first!;
  }

  private parseNode(): SgfNode {
    this.i++;
    this.nodes++;
    if (this.nodes > this.limits.maxNodes) {
      throw this.err("SGF_LIMIT_EXCEEDED", "节点数超过限制 " + this.limits.maxNodes, this.i);
    }
    const props: Record<string, string[]> = {};
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === undefined || c === ";" || c === "(" || c === ")") break;
      if (c === "[") {
        throw this.err("SGF_MISSING_PROP_IDENT", "属性值 '[' 前缺少属性名", this.i);
      }
      if (!isUpper(c)) {
        throw this.err("SGF_BAD_PROP_NAME", "属性名必须是大写 ASCII 字母，得到 '" + c + "'", this.i);
      }
      const start = this.i;
      while (this.peek() !== undefined && isUpper(this.peek()!)) this.i++;
      const name = this.chars.slice(start, this.i).join("");
      if (name in props) {
        throw this.err("SGF_DUPLICATE_PROPERTY", "同一节点重复属性 '" + name + "'", start);
      }
      this.skipWs();
      const after = this.peek();
      if (after !== undefined && after >= "a" && after <= "z") {
        throw this.err("SGF_BAD_PROP_NAME", "属性名必须是大写 ASCII 字母，得到 '" + after + "'", this.i);
      }
      if (after !== "[") {
        throw this.err("SGF_MISSING_PROP_IDENT", "属性 '" + name + "' 后缺少方括号值", this.i);
      }
      const values: string[] = [];
      while (this.peek() === "[") {
        values.push(coerceValue(name, this.parseValue()));
        this.skipWs();
      }
      props[name] = values;
    }
    return { props, children: [] };
  }

  /** 方括号值的状态机：处理 \]、\\、软换行与其他转义。 */
  private parseValue(): string {
    const start = this.i;
    this.i++;
    let out = "";
    for (;;) {
      const c = this.chars[this.i];
      if (c === undefined) {
        throw this.err("SGF_UNCLOSED_VALUE", "属性值未闭合（缺少 ']'）", start);
      }
      if (c === "]") {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const next = this.chars[this.i + 1];
        if (next === undefined) {
          throw this.err("SGF_DANGLING_BACKSLASH", "值末尾出现悬空反斜杠", this.i);
        }
        if (next === "\r") {
          this.i += this.chars[this.i + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (next === "\n") {
          this.i += 2;
          continue;
        }
        out += next;
        this.i += 2;
        continue;
      }
      if (c === "\r") {
        out += "\n";
        this.i += this.chars[this.i + 1] === "\n" ? 2 : 1;
        continue;
      }
      out += c;
      this.i++;
    }
  }
}

export function parseCollection(text: string, limits: ParseLimits = DEFAULT_LIMITS): SgfNode[] {
  return new Parser(text, limits).parseCollection();
}

function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function serializeNode(node: SgfNode): string {
  let s = ";";
  for (const name of Object.keys(node.props)) {
    s += name;
    for (const v of node.props[name]) s += "[" + escapeValue(v) + "]";
  }
  return s;
}

function serializeTree(node: SgfNode): string {
  let s = "(";
  let cur = node;
  for (;;) {
    s += serializeNode(cur);
    if (cur.children.length === 0) break;
    if (cur.children.length === 1) {
      cur = cur.children[0];
      continue;
    }
    for (const child of cur.children) s += "\n" + serializeTree(child);
    break;
  }
  return s + ")";
}

export function serializeCollection(roots: SgfNode[]): string {
  return roots.map(serializeTree).join("\n") + "\n";
}

/**
 * 确定路径标识：根为 "R"，子节点为 "<父路径>.<子序号>"（0 基）。
 * 主线延续恒为序号 0；变化分支按原文出现顺序为 1、2、…。
 */
export const ROOT_PATH = "R";

export function childPath(parentPath: string, index: number): string {
  return parentPath + "." + index;
}

export function parsePath(path: string): number[] {
  if (path === ROOT_PATH) return [];
  if (!/^R(\.\d+)+$/.test(path)) throw new Error("非法路径: " + path);
  return path.slice(2).split(".").map(Number);
}

export function getNodeAtPath(root: SgfNode, path: string): SgfNode | null {
  let cur = root;
  for (const idx of parsePath(path)) {
    const next = cur.children[idx];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export function parentPath(path: string): string | null {
  if (path === ROOT_PATH) return null;
  return path.slice(0, path.lastIndexOf("."));
}

/** 从根到指定路径的祖先链（含根与自身），分叉点只出现一次。 */
export function pathToRoot(path: string): string[] {
  const steps = parsePath(path);
  const out = [ROOT_PATH];
  let cur = ROOT_PATH;
  for (const s of steps) {
    cur = childPath(cur, s);
    out.push(cur);
  }
  return out;
}

export function countNodes(root: SgfNode): number {
  let n = 1;
  for (const c of root.children) n += countNodes(c);
  return n;
}

/** 结构等价比较（属性顺序与值顺序敏感）。 */
export function structurallyEqual(a: SgfNode, b: SgfNode): boolean {
  const ka = Object.keys(a.props);
  const kb = Object.keys(b.props);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const va = a.props[ka[i]];
    const vb = b.props[kb[i]];
    if (va.length !== vb.length || va.some((v, j) => v !== vb[j])) return false;
  }
  if (a.children.length !== b.children.length) return false;
  return a.children.every((c, i) => structurallyEqual(c, b.children[i]));
}
