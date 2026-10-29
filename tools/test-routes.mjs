// 宿主半边冒烟测试：用假 ctx 跑 apply()，再把两条路由都打一遍。
// 默认测**运行时真正加载的那份**（profile 里的拷贝）；没有就退回源码。
//
//   node tools/test-routes.mjs
//
// 会真的去请求 opencode.ai/zen/go/v1/usage（只读、不消耗额度），key 从
// ~/.dsh/.credentials.yaml 的 refs.OPENCODE_GO_API_KEY 读，或从环境变量读。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const profile = process.argv[2] || process.env.DSH_PROFILE || "web";

const deployed = join(home, "profiles", profile, "node_modules", "@local", "dsh-opencode-usage", "lib", "index.js");
const source = resolve(here, "..", "lib", "index.js");
const target = existsSync(deployed) ? deployed : source;
console.log((target === deployed ? "测运行时拷贝 " : "测源码 ") + target + "\n");

/** 假凭据服务：模拟 DSH 的 credentials.resolve()（env → .credentials.yaml refs → .env）。 */
function makeCredentials() {
	let refs = {};
	try {
		const y = readFileSync(join(home, ".credentials.yaml"), "utf8");
		const m = y.match(/^refs:\n((?:\s+\S+:.*\n)+)/m);
		if (m) {
			for (const line of m[1].split("\n")) {
				const kv = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line);
				if (kv) refs[kv[1]] = kv[2];
			}
		}
	} catch {}
	return {
		async resolve(ref) {
			if (process.env[ref]) return { value: process.env[ref], source: "env" };
			if (refs[ref]) return { value: refs[ref], source: "file" };
			return undefined;
		}
	};
}

const mod = await import(pathToFileURL(target).href);

let registered = null;
const commands = [];
const injectedDeps = [];
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
const ctx = {
	logger: log,
	credentials: makeCredentials(),
	webServer: { register: (opts) => { registered = opts; return () => {}; } },
	effect: (fn) => { fn(); },
	// 插件用 ctx.inject(["commands"], cb) 注册聊天命令：这里把可选子作用域也模拟出来
	inject: (deps, cb) => {
		injectedDeps.push(deps.join(","));
		cb({
			logger: log,
			effect: (fn) => { fn(); },
			commands: { register: (def) => { commands.push(def); return () => {}; } }
		});
	}
};

mod.apply(ctx, {});
if (!registered || registered.kind !== "prefix" || registered.path !== "/api/opencode-usage") {
	console.log("FAIL 路由没注册：" + JSON.stringify(registered));
	process.exit(1);
}
console.log("ok    路由已注册 " + registered.kind + " " + registered.path + "\n");

const call = (url) => new Promise((done) => {
	const res = { status: 0, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b || ""; done(this); } };
	Promise.resolve(registered.handler({ url, method: "GET" }, res)).catch((e) => { res.status = -1; res.body = String(e); done(res); });
});

let fails = 0;
const check = (label, ok, extra) => {
	console.log((ok ? "ok    " : "FAIL  ") + label + (extra ? "  " + extra : ""));
	if (!ok) fails++;
};

{
	const res = await call("/api/opencode-usage/ping");
	const json = JSON.parse(res.body);
	check("ping 探活", res.status === 200 && json.ok === true, json.text);
}
{
	const res = await call("/api/opencode-usage/nope");
	check("未知命令 404", res.status === 404);
}
{
	const res = await call("/api/opencode-usage/usage?fresh=true");
	let json = null;
	try { json = JSON.parse(res.body); } catch {}
	const u = json && json.usage;
	const windows = u ? ["rolling", "weekly", "monthly"].filter((k) => u[k] && typeof u[k].percent === "number") : [];
	check("usage 拿到三个窗口的 percent", res.status === 200 && json.ok && windows.length === 3,
		windows.map((k) => k + "=" + u[k].percent + "%").join(" ") + (json && json.error ? " err=" + json.error : ""));
	check("每个窗口都带 resetsAt", windows.every((k) => typeof u[k].resetsAt === "string"));
	check("key 来源已标注", json.keySource === "env" || json.keySource === "file", "source=" + json.keySource);
	const second = await call("/api/opencode-usage/usage");
	const j2 = JSON.parse(second.body);
	check("第二次命中 30s 缓存", j2.cached === true, "cached=" + j2.cached);
}

// ── 节假日日历（挂件那条峰谷提示用） ────────────────────────────────────────
{
	const res = await call("/api/opencode-usage/holidays?year=2026");
	let json = null;
	try { json = JSON.parse(res.body); } catch {}
	const days = (json && json.days) || [];
	check("holidays 200 + 有 days", res.status === 200 && json.ok === true && days.length > 0,
		"n=" + days.length + " source=" + (json && json.source));
	const national = days.find((d) => d.date === "2026-10-01");
	check("10-01 标成放假", !!national && national.off === true, national ? national.name : "缺");
	const makeup = days.find((d) => d.date === "2026-10-10");
	check("10-10 标成调休上班", !!makeup && makeup.off === false, makeup ? makeup.name : "缺");
	const again = JSON.parse((await call("/api/opencode-usage/holidays?year=2026")).body);
	check("第二次命中宿主机缓存（fetchedAt 不变）", again.fetchedAt === json.fetchedAt, again.fetchedAt);
	const outOfRange = await call("/api/opencode-usage/holidays?year=1990");
	check("年份越界退回今年（不炸）", outOfRange.status === 200, "status=" + outOfRange.status);
}

// ── 聊天命令 ────────────────────────────────────────────────────────────────
check("命令注册在可选作用域里（没硬性依赖 commands）", injectedDeps.includes("commands"), injectedDeps.join(" / "));
check("命令名与描述", commands.length === 1 && commands[0].name === "opencode-go" && typeof commands[0].description === "string",
	JSON.stringify(commands.map((c) => c.name)));

if (commands.length === 1) {
	const handler = commands[0].handler;
	{
		const r = await handler({ rawInput: "" });
		const text = r && r.text ? r.text : "";
		const hasAll = ["滚动 5h", "本周", "本期"].every((w) => text.includes(w)) && text.includes("重置") && text.includes("OpenCode GO 配额");
		check("/opencode-go 输出三个窗口 + 重置时间", r && r.kind === "success" && hasAll);
		console.log("      文本预览：\n" + text.split("\n").map((l) => "        " + l).join("\n"));
	}
	{
		const r = await handler({ rawInput: " json" });
		const text = r && r.text ? r.text : "";
		check("/opencode-go json 回原始 JSON", r && r.kind === "success" && text.includes("```json") && text.includes("\"usage\""), text.slice(0, 40));
	}
	{
		const r = await handler({});
		check("没有 rawInput 也不炸（走默认文本）", r && r.kind === "success" && r.text.includes("OpenCode GO"));
	}
}

// 凭据缺失时应回 kind=error 而不是抛出去（本机若设了同名环境变量就跳过这条）
if (!process.env.OPENCODE_GO_API_KEY) {
	const bare = await import(pathToFileURL(target).href + "?bare=1");
	const bareCommands = [];
	bare.apply({
		logger: log,
		credentials: { resolve: async () => undefined },
		webServer: { register: () => () => {} },
		effect: (fn) => { fn(); },
		inject: (deps, cb) => cb({ logger: log, effect: (fn) => { fn(); }, commands: { register: (d) => { bareCommands.push(d); return () => {}; } } })
	}, {});
	const r = bareCommands.length ? await bareCommands[0].handler({ rawInput: "" }) : null;
	check("凭据缺失时返回 kind=error（不抛异常）", r && r.kind === "error" && /凭据/.test(r.text), r ? r.text.slice(0, 70) : "no command");
}

console.log(fails ? `\nFAILURES: ${fails}` : "\n路线全部通过（路由 + 聊天命令）");
// 让 undici 的连接池先收工再退出：否则 Node 退出时可能对"正在关闭的 socket"触发
// libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），看着像测试挂了。
try {
	const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
	if (dispatcher && typeof dispatcher.close === "function") await dispatcher.close();
} catch {}
process.exitCode = fails ? 1 : 0;
