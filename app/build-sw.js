import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const source = await readFile(new URL("./src/service-worker.js", import.meta.url), "utf8");
await writeFile(new URL("./public/sw.js", import.meta.url), source.replace("__BUILD_VERSION__", randomUUID()));
