// API 冒烟测试：node scripts/smoke.ts
import { Store } from "../src/store.ts";
import { startServer } from "../src/server.ts";

const store = new Store(":memory:");
const { port, server } = await startServer(store, 0);
console.log("port", port);
const j = async (r: Response) => ({ status: r.status, body: await r.json() });
const post = (p: string, body?: unknown) =>
  fetch("http://127.0.0.1:" + port + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (p: string) => fetch("http://127.0.0.1:" + port + p);

console.log(JSON.stringify(await j(await post("/api/collections", { text: "(;FF[4]GM[1];B[aa](;W[bb])(;W[cc];B[dd]))" }))));
console.log(JSON.stringify(await j(await get("/api/games"))));
console.log(JSON.stringify(await j(await get("/api/games/1/node?path=R.0.1"))));
const cur = await j(await post("/api/cursors", { gameId: 1 }));
console.log(JSON.stringify(cur));
const cid = cur.body.cursorId;
console.log(JSON.stringify(await j(await post("/api/cursors/" + cid + "/forward"))));
console.log(JSON.stringify(await j(await post("/api/cursors/" + cid + "/forward", {}))));
console.log(JSON.stringify(await j(await post("/api/cursors/" + cid + "/forward", { branch: 1 }))));
console.log(JSON.stringify(await j(await post("/api/cursors/" + cid + "/back"))));
console.log(JSON.stringify(await j(await post("/api/games/1/verify"))));
console.log(JSON.stringify(await j(await post("/api/collections", { text: "(;C[未闭合)" }))));
server.close();
store.close();
