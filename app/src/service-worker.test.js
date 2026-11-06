import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const events = {};
const deleted = [];
const entries = new Map([["/", new Response("old")] ]);
let offline = false;
const context = {
  URL, self: { location: { origin: "https://example.com" }, addEventListener: (name, fn) => events[name] = fn, clients: { claim: async () => {} } },
  caches: { keys: async () => ["app-v1", "app-test", "explain-v1"], delete: async (key) => deleted.push(key), open: async () => ({ match: async (key) => entries.get(key)?.clone(), put: async (key, value) => entries.set(key, value) }) },
  fetch: async () => { if (offline) throw Error("offline"); return new Response("new"); },
};
vm.runInNewContext((await readFile(new URL("./service-worker.js", import.meta.url), "utf8")).replace("__BUILD_VERSION__", "test"), context);
let activation;
events.activate({ waitUntil: (promise) => activation = promise });
await activation;
assert.deepEqual(deleted, ["app-v1"], "only obsolete app caches are deleted");
async function get(path, mode = "navigate") {
  let response;
  events.fetch({ request: { url: `https://example.com${path}`, method: "GET", mode }, respondWith: (promise) => response = promise });
  return response;
}
assert.equal(await (await get("/")).text(), "new", "online navigation bypasses stale HTML");
offline = true;
assert.equal(await (await get("/")).text(), "new", "offline navigation uses cached HTML");
assert.equal(await get("/api/sync"), undefined, "API requests are never cached");
console.log("service worker cache lifecycle ok");
