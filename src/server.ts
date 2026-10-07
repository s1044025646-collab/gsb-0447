import http from 'node:http';
import { Store } from './store.js';
import { SgfError } from './errors.js';
import { moveCursor, nodeInfo, renderBranch, renderTree, treeSummary, MoveOp } from './service.js';

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) reject(new SgfError('LIMIT_TEXT_LENGTH', 'request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/api/import') {
        const body = JSON.parse(await readBody(req));
        if (typeof body.text !== 'string') throw new SgfError('VALIDATION', 'field "text" (string) is required');
        const result = store.importCollection(body.text, body.importKey);
        return send(res, 200, {
          reused: result.reused,
          trees: result.trees.map((t, i) => ({ ...t, summary: treeSummary(result.collection.trees[i]) })),
        });
      }
      if (method === 'GET' && url.pathname === '/api/trees') {
        return send(res, 200, { trees: store.listTrees() });
      }
      if (parts[0] === 'api' && parts[1] === 'trees' && parts[2]) {
        const treeId = parts[2];
        if (method === 'GET' && parts.length === 3) {
          const tree = store.loadTree(treeId);
          return send(res, 200, { ...store.getTreeRow(treeId), summary: treeSummary(tree), view: renderTree(tree) });
        }
        if (method === 'GET' && parts[3] === 'node') {
          const tree = store.loadTree(treeId);
          return send(res, 200, nodeInfo(tree, url.searchParams.get('path') ?? '0'));
        }
        if (method === 'GET' && parts[3] === 'branch') {
          const tree = store.loadTree(treeId);
          return send(res, 200, { view: renderBranch(tree, url.searchParams.get('path') ?? '0') });
        }
        if (method === 'GET' && parts[3] === 'export') {
          return send(res, 200, { sgf: store.exportTree(treeId) });
        }
        if (method === 'POST' && parts[3] === 'verify') {
          return send(res, 200, store.verifyTree(treeId));
        }
      }
      if (method === 'POST' && url.pathname === '/api/cursors') {
        const body = JSON.parse(await readBody(req));
        if (typeof body.treeId !== 'string') throw new SgfError('VALIDATION', 'field "treeId" is required');
        return send(res, 200, store.createCursor(body.treeId));
      }
      if (parts[0] === 'api' && parts[1] === 'cursors' && parts[2]) {
        if (method === 'GET' && parts.length === 3) return send(res, 200, store.getCursor(parts[2]));
        if (method === 'POST' && parts[3] === 'move') {
          const body = JSON.parse(await readBody(req));
          const op = body.op as MoveOp;
          if (!['forward', 'back', 'choose', 'root'].includes(op)) {
            throw new SgfError('VALIDATION', 'op must be one of forward|back|choose|root');
          }
          return send(res, 200, moveCursor(store, parts[2], op, body.branch));
        }
      }
      throw new SgfError('NOT_FOUND', `no route for ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof SgfError) return send(res, 400, { error: e.toJSON() });
      if (e instanceof SyntaxError) return send(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON body' } });
      throw e;
    }
  });
}
