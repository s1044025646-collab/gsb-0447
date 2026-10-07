// SQLite 持久化：原文摘要、FF 版本、树结构与游标位置。
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  parseCollection, serializeCollection, countNodes,
  ROOT_PATH, childPath, parentPath, getNodeAtPath, pathToRoot, structurallyEqual,
  DEFAULT_LIMITS, SgfError,
} from "./sgf.ts";
import type { SgfNode, ParseLimits } from "./sgf.ts";

export interface GameRow {
  id: number;
  hash: string;
  ff: string;
  nodeCount: number;
  createdAt: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export class Store {
  private db: DatabaseSync;
  private limits: ParseLimits;
  constructor(dbPath: string, limits: ParseLimits = DEFAULT_LIMITS) {
    this.limits = limits;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS imports (
        hash TEXT PRIMARY KEY,
        game_ids TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        ff TEXT NOT NULL,
        source TEXT NOT NULL,
        tree TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        id TEXT PRIMARY KEY,
        game_id INTEGER NOT NULL REFERENCES games(id),
        path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private hashOf(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  /** 导入集合：同一文本重复提交返回原结果；任何失败整体回滚。 */
  importCollection(text: string): { importHash: string; gameIds: number[]; duplicate: boolean } {
    const importHash = this.hashOf(text);
    const existing = this.db.prepare("SELECT game_ids FROM imports WHERE hash = ?").get(importHash) as
      | { game_ids: string }
      | undefined;
    if (existing) {
      return { importHash, gameIds: JSON.parse(existing.game_ids), duplicate: true };
    }
    const roots = parseCollection(text, this.limits); // 解析失败时不写任何数据
    const now = new Date().toISOString();
    const gameIds: number[] = [];
    this.db.exec("BEGIN");
    try {
      const insGame = this.db.prepare(
        "INSERT INTO games (hash, ff, source, tree, node_count, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const root of roots) {
        const treeJson = JSON.stringify(root);
        const ff = root.props.FF?.[0] ?? "";
        const gameHash = this.hashOf(serializeCollection([root]));
        const r = insGame.run(gameHash, ff, text, treeJson, countNodes(root), now);
        gameIds.push(Number(r.lastInsertRowid));
      }
      this.db
        .prepare("INSERT INTO imports (hash, game_ids, created_at) VALUES (?, ?, ?)")
        .run(importHash, JSON.stringify(gameIds), now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { importHash, gameIds, duplicate: false };
  }

  listGames(): GameRow[] {
    const rows = this.db
      .prepare("SELECT id, hash, ff, node_count, created_at FROM games ORDER BY id")
      .all() as unknown as { id: number; hash: string; ff: string; node_count: number; created_at: string }[];
    return rows.map((r) => ({ id: r.id, hash: r.hash, ff: r.ff, nodeCount: r.node_count, createdAt: r.created_at }));
  }

  private getTree(gameId: number): SgfNode {
    const row = this.db.prepare("SELECT tree FROM games WHERE id = ?").get(gameId) as { tree: string } | undefined;
    if (!row) throw new ApiError("GAME_NOT_FOUND", "棋谱不存在: " + gameId, 404);
    return JSON.parse(row.tree) as SgfNode;
  }

  getGame(gameId: number): { id: number; ff: string; source: string; nodeCount: number } {
    const row = this.db.prepare("SELECT id, ff, source, node_count FROM games WHERE id = ?").get(gameId) as
      | { id: number; ff: string; source: string; node_count: number }
      | undefined;
    if (!row) throw new ApiError("GAME_NOT_FOUND", "棋谱不存在: " + gameId, 404);
    return { id: row.id, ff: row.ff, source: row.source, nodeCount: row.node_count };
  }

  getNode(gameId: number, path: string): { path: string; props: Record<string, string[]>; children: number[]; pathToRoot: string[] } {
    const tree = this.getTree(gameId);
    const node = getNodeAtPath(tree, path);
    if (!node) throw new ApiError("NODE_NOT_FOUND", "路径不存在: " + path, 404);
    return {
      path,
      props: node.props,
      children: node.children.map((_, i) => i),
      pathToRoot: pathToRoot(path),
    };
  }

  exportGame(gameId: number): string {
    return serializeCollection([this.getTree(gameId)]);
  }

  /** 导出 -> 重新解析 -> 结构等价核验。 */
  verifyGame(gameId: number): { ok: boolean } {
    const tree = this.getTree(gameId);
    const exported = serializeCollection([tree]);
    const reparsed = parseCollection(exported, this.limits);
    return { ok: reparsed.length === 1 && structurallyEqual(tree, reparsed[0]) };
  }

  // ---------- 游标 ----------

  createCursor(gameId: number): { cursorId: string; gameId: number; path: string } {
    this.getTree(gameId);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO cursors (id, game_id, path, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, gameId, ROOT_PATH, new Date().toISOString());
    return { cursorId: id, gameId, path: ROOT_PATH };
  }

  private getCursor(cursorId: string): { game_id: number; path: string } {
    const row = this.db.prepare("SELECT game_id, path FROM cursors WHERE id = ?").get(cursorId) as
      | { game_id: number; path: string }
      | undefined;
    if (!row) throw new ApiError("CURSOR_NOT_FOUND", "游标不存在: " + cursorId, 404);
    return row;
  }

  private setPath(cursorId: string, path: string): void {
    this.db.prepare("UPDATE cursors SET path = ?, updated_at = ? WHERE id = ?").run(path, new Date().toISOString(), cursorId);
  }

  cursorState(cursorId: string): { cursorId: string; gameId: number; path: string; props: Record<string, string[]>; children: number[] } {
    const cur = this.getCursor(cursorId);
    const tree = this.getTree(cur.game_id);
    const node = getNodeAtPath(tree, cur.path);
    if (!node) throw new ApiError("CURSOR_STALE", "游标路径在当前版本中无效: " + cur.path, 409);
    return { cursorId, gameId: cur.game_id, path: cur.path, props: node.props, children: node.children.map((_, i) => i) };
  }

  /** 向后走一步。多个子节点时必须显式给出 branch。 */
  cursorForward(cursorId: string, branch?: number): { cursorId: string; path: string } {
    const cur = this.getCursor(cursorId);
    const tree = this.getTree(cur.game_id);
    const node = getNodeAtPath(tree, cur.path);
    if (!node) throw new ApiError("CURSOR_STALE", "游标路径在当前版本中无效: " + cur.path, 409);
    if (node.children.length === 0) throw new ApiError("NO_CHILD", "已到分支末尾，无法前进");
    let idx: number;
    if (node.children.length === 1 && branch === undefined) {
      idx = 0;
    } else {
      if (branch === undefined) {
        throw new ApiError("BRANCH_REQUIRED", "存在 " + node.children.length + " 个子分支，必须显式选择 branch");
      }
      if (!Number.isInteger(branch) || branch < 0 || branch >= node.children.length) {
        throw new ApiError("BRANCH_OUT_OF_RANGE", "分支序号越界: " + branch);
      }
      idx = branch;
    }
    const next = childPath(cur.path, idx);
    this.setPath(cursorId, next);
    return { cursorId, path: next };
  }

  cursorBack(cursorId: string): { cursorId: string; path: string } {
    const cur = this.getCursor(cursorId);
    const parent = parentPath(cur.path);
    if (parent === null) throw new ApiError("AT_ROOT", "已在根节点，无法后退");
    this.setPath(cursorId, parent);
    return { cursorId, path: parent };
  }
}

export { SgfError };
