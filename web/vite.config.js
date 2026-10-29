import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CHAIN_ID, EVM_RPC } from "../lib/endpoints.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const snapshotDir = path.join(repoRoot, "snapshots");
const outputDir = path.join(repoRoot, "dist");

function snapshotFile(url) {
  const name = decodeURIComponent(String(url || "").split("?")[0].replace(/^\/+/, ""));
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const file = path.join(snapshotDir, name);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

function snapshotsMiddleware(req, res, next) {
  const name = decodeURIComponent(String(req.url || "").split("?")[0].replace(/^\/+/, ""));
  if (!name.endsWith(".json")) {
    next();
    return;
  }
  const file = snapshotFile(req.url);
  if (!file) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("not found");
    return;
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  createReadStream(file).pipe(res);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const evmConfig = {
    rpc: env.EVM_RPC || EVM_RPC,
    chainId: Number(env.CHAIN_ID || CHAIN_ID),
  };

  return {
    root: here,
    envDir: repoRoot,
    server: {
      port: 5173,
      fs: { allow: [repoRoot] },
    },
    plugins: [
      {
        name: "portaldot-snapshots",
        configureServer(server) {
          server.middlewares.use("/snapshots", snapshotsMiddleware);
        },
        configurePreviewServer(server) {
          server.middlewares.use("/snapshots", snapshotsMiddleware);
        },
        closeBundle() {
          const out = path.join(outputDir, "snapshots");
          mkdirSync(out, { recursive: true });
          for (const name of readdirSync(snapshotDir)) {
            if (!name.endsWith(".json")) continue;
            copyFileSync(path.join(snapshotDir, name), path.join(out, name));
          }
        },
      },
    ],
    define: {
      global: "globalThis",
      __PORTALDOT_EVM_CONFIG__: JSON.stringify(evmConfig),
    },
    optimizeDeps: {
      esbuildOptions: {
        define: { global: "globalThis" },
      },
    },
    build: {
      outDir: outputDir,
      emptyOutDir: true,
    },
  };
});
