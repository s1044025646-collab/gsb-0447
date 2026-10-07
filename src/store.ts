import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Collection, GameTree, RULES_VERSION, SgfNode } from './model.js';
import { parseCollection } from './parser.js';
import { exportCollection, treeFromJSON, treeToJSON } from './serializer.js';
import { SgfError } from './errors.js';

export interface TreeRow {
  id: string;
  sha256: string;
  rules_version: string;
  tree_index: number;
  node_count: number;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'sgf.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS imports (
        import_key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        tree_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        structure_json TEXT NOT NULL,
        node_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL,
        path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  importCollection(text: string, importKey?: string): { trees: TreeRow[]; collection: Collection; reused: boolean } {
    if (importKey) {
      const row = this.db.prepare('SELECT result_json FROM imports WHERE import_key = ?').get(importKey) as any;
      if (row) {
        const result = JSON.parse(row.result_json as string);
        const trees = result.treeIds.map((id: string) => this.getTreeRow(id));
        const collection: Collection = { trees: trees.map((t: TreeRow) => this.loadTree(t.id)) };
        return { trees, collection, reused: true };
      }
    }
    // parse first; failures leave nothing behind
    const collection = parseCollection(text);
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    const existing = this.db.prepare('SELECT id FROM trees WHERE sha256 = ? ORDER BY created_at').all(sha) as any[];
    if (existing.length === collection.trees.length && existing.length > 0) {
      const trees = existing.map((r) => this.getTreeRow(r.id));
      if (importKey) {
        this.db.prepare('INSERT OR IGNORE INTO imports (import_key, result_json) VALUES (?, ?)')
          .run(importKey, JSON.stringify({ treeIds: trees.map((t) => t.id) }));
      }
      return { trees, collection, reused: true };
    }
    const now = new Date().toISOString();
    const trees: TreeRow[] = [];
    const insert = this.db.prepare(
      'INSERT INTO trees (id, sha256, rules_version, tree_index, text, structure_json, node_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.db.exec('BEGIN');
    try {
      collection.trees.forEach((tree, idx) => {
        const id = randomUUID();
        insert.run(id, sha, RULES_VERSION, idx, text, JSON.stringify(treeToJSON(tree.root)), tree.nodeCount, now);
        trees.push(this.getTreeRow(id));
      });
      if (importKey) {
        this.db.prepare('INSERT INTO imports (import_key, result_json) VALUES (?, ?)')
          .run(importKey, JSON.stringify({ treeIds: trees.map((t) => t.id) }));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { trees, collection, reused: false };
  }

  getTreeRow(id: string): TreeRow {
    const row = this.db.prepare('SELECT id, sha256, rules_version, tree_index, node_count, created_at FROM trees WHERE id = ?').get(id) as any;
    if (!row) throw new SgfError('NOT_FOUND', `tree ${id} not found`);
    return row as TreeRow;
  }

  listTrees(): TreeRow[] {
    return this.db.prepare('SELECT id, sha256, rules_version, tree_index, node_count, created_at FROM trees ORDER BY created_at, tree_index').all() as any as TreeRow[];
  }

  loadTree(id: string): GameTree {
    const row = this.db.prepare('SELECT structure_json FROM trees WHERE id = ?').get(id) as any;
    if (!row) throw new SgfError('NOT_FOUND', `tree ${id} not found`);
    const root = treeFromJSON(JSON.parse(row.structure_json as string));
    let nodeCount = 0;
    const stack = [root];
    while (stack.length) {
      nodeCount++;
      const n = stack.pop()!;
      for (const c of n.children) stack.push(c);
    }
    return { root, nodeCount, maxDepth: 0 };
  }

  exportTree(id: string): string {
    const tree = this.loadTree(id);
    return exportCollection({ trees: [tree] });
  }

  verifyTree(id: string): { ok: boolean; detail: string } {
    const exported = this.exportTree(id);
    const reparsed = parseCollection(exported);
    const again = exportCollection(reparsed);
    return { ok: exported === again, detail: ok_detail(exported, again) };
  }

  createCursor(treeId: string): { id: string; treeId: string; path: string } {
    this.getTreeRow(treeId);
    const id = randomUUID();
    this.db.prepare('INSERT INTO cursors (id, tree_id, path, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, treeId, '0', new Date().toISOString());
    return { id, treeId, path: '0' };
  }

  getCursor(id: string): { id: string; treeId: string; path: string } {
    const row = this.db.prepare('SELECT id, tree_id, path FROM cursors WHERE id = ?').get(id) as any;
    if (!row) throw new SgfError('NOT_FOUND', `cursor ${id} not found`);
    return { id: row.id, treeId: row.tree_id, path: row.path };
  }

  setCursorPath(id: string, pathStr: string): void {
    this.db.prepare('UPDATE cursors SET path = ?, updated_at = ? WHERE id = ?')
      .run(pathStr, new Date().toISOString(), id);
  }
}

function ok_detail(a: string, b: string): string {
  return a === b ? 'export is stable under reparse' : 'export mismatch after reparse';
}
