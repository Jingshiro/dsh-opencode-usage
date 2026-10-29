#!/usr/bin/env node
/**
 * Inline assets/*.webp into lib/client.js as base64 data URIs.
 *
 * Why base64 instead of a static route: the browser half has no server of its
 * own, and DSH serves client modules without exposing arbitrary package files.
 * Two 40 KB webp images cost ~120 KB of bundle and zero extra requests.
 *
 *   node tools/build-art.mjs            # rewrite the marked block in lib/client.js
 *   node tools/build-art.mjs --check    # fail if the block is stale (CI friendly)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const clientPath = join(root, "lib", "client.js");
const assets = join(root, "assets");

const b64 = (file) => readFileSync(join(assets, file)).toString("base64");

const block = [
	"\t\t/* art:start */",
	"\t\tconst ART = {",
	`\t\t\toffpeak: "data:image/webp;base64,${b64("chibi-offpeak.webp")}",`,
	`\t\t\tpeak: "data:image/webp;base64,${b64("chibi-peak.webp")}"`,
	"\t\t};",
	"\t\t/* art:end */"
].join("\n");

const source = readFileSync(clientPath, "utf8");
const pattern = /\/\* art:start \*\/[\s\S]*?\/\* art:end \*\//;
if (!pattern.test(source)) {
	console.error("lib/client.js 里找不到 /* art:start */ … /* art:end */ 标记");
	process.exit(1);
}
const next = source.replace(pattern, block);
if (process.argv.includes("--check")) {
	if (next !== source) {
		console.error("lib/client.js 里的内嵌图是旧的，跑一次 node tools/build-art.mjs");
		process.exit(1);
	}
	console.log("ok: 内嵌图与 assets/ 一致");
} else {
	writeFileSync(clientPath, next);
	console.log("ok: 已把 assets/*.webp 内嵌进 lib/client.js（" + Math.round(next.length / 1024) + " KB）");
}
