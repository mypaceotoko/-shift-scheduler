import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("out"),
  prefix = process.env.NEXT_PUBLIC_BASE_PATH ?? "/-shift-scheduler";
createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://local").pathname;
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    let target = resolve(
      root,
      "." + decodeURIComponent(path.slice(prefix.length) || "/"),
    );
    if (!target.startsWith(root + "/") && target !== root) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(target)).isDirectory())
      target = resolve(target, "index.html");
    const mime =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".txt": "text/plain",
        ".wasm": "application/wasm",
      }[extname(target)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await readFile(target));
  } catch {
    res.writeHead(404).end();
  }
}).listen(4173, "127.0.0.1");
