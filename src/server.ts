// HTTP API：仅后端，无棋盘 UI。
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { Store, ApiError } from "./store.ts";
import { SgfError } from "./sgf.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

export function startServer(store: Store, port: number): Promise<{ port: number; server: Server }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/api/collections") {
        const body = JSON.parse(await readBody(req));
        if (typeof body.text !== "string" || body.text.length === 0) {
          throw new ApiError("BAD_REQUEST", "请求体需为 { \"text\": \"<SGF 文本>\" }");
        }
        send(res, 200, store.importCollection(body.text));
        return;
      }
      if (method === "GET" && url.pathname === "/api/games") {
        send(res, 200, store.listGames());
        return;
      }
      if (parts[0] === "api" && parts[1] === "games" && parts[2]) {
        const gameId = Number(parts[2]);
        if (!Number.isInteger(gameId)) throw new ApiError("BAD_REQUEST", "gameId 必须是整数");
        if (method === "GET" && parts.length === 3) {
          send(res, 200, store.getGame(gameId));
          return;
        }
        if (method === "GET" && parts[3] === "node") {
          const path = url.searchParams.get("path") ?? "R";
          send(res, 200, store.getNode(gameId, path));
          return;
        }
        if (method === "GET" && parts[3] === "export") {
          const text = store.exportGame(gameId);
          res.writeHead(200, { "content-type": "application/x-go-sgf; charset=utf-8" });
          res.end(text);
          return;
        }
        if (method === "POST" && parts[3] === "verify") {
          send(res, 200, store.verifyGame(gameId));
          return;
        }
      }
      if (method === "POST" && url.pathname === "/api/cursors") {
        const body = JSON.parse(await readBody(req));
        if (!Number.isInteger(body.gameId)) throw new ApiError("BAD_REQUEST", "需要 { \"gameId\": <整数> }");
        send(res, 200, store.createCursor(body.gameId));
        return;
      }
      if (parts[0] === "api" && parts[1] === "cursors" && parts[2]) {
        const cursorId = parts[2];
        if (method === "GET" && parts.length === 3) {
          send(res, 200, store.cursorState(cursorId));
          return;
        }
        if (method === "POST" && parts[3] === "forward") {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          send(res, 200, store.cursorForward(cursorId, body.branch));
          return;
        }
        if (method === "POST" && parts[3] === "back") {
          send(res, 200, store.cursorBack(cursorId));
          return;
        }
      }
      throw new ApiError("NOT_FOUND", "未知路由: " + method + " " + url.pathname, 404);
    } catch (e) {
      if (e instanceof SgfError) send(res, 400, { error: e.toJSON() });
      else if (e instanceof ApiError) send(res, e.status, { error: e.toJSON() });
      else if (e instanceof SyntaxError) send(res, 400, { error: { code: "BAD_JSON", message: "请求体不是合法 JSON" } });
      else send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, server });
    });
  });
}
