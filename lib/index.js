// dsh-opencode-usage — 宿主半边。
//
// 把 OpenCode GO 套餐的配额（滚动 5h / 本周 / 本期三个窗口）从官方接口取回来，给两个出口用：
//
//   1) 同源路由（浏览器挂件）
//        GET /api/opencode-usage/usage[?fresh=true]   三个窗口的 percent + resetsAt
//        GET /api/opencode-usage/ping                 探活（不碰上游，只证明桥活着）
//   2) 聊天命令（可选：commands 服务在才有）
//        /opencode-go           三行文本
//        /opencode-go json      上游原始 JSON
//
// 上游：GET https://opencode.ai/zen/go/v1/usage  Authorization: Bearer <key>
//   → { usage: { rolling: {status,percent,resetsAt}, weekly: {...}, monthly: {...} } }
// 官方不提供美元明细（只在 opencode.ai/auth 控制台），这里也不编。
//
// 这个调用是纯账户状态读取，不消耗套餐额度。key 通过 DSH 的 credentials 服务解析
// （环境变量 / .credentials.yaml / .env 三层都认），只发给 opencode 官方网关，
// 不进浏览器、不进日志。
const name = "dsh-opencode-usage";

/** 必需服务：web 路由 + 凭据解析。commands 走可选子作用域（见 apply），
 *  免得某个环境里没有它就把挂件一起拖死。 */
const inject = ["webServer", "credentials"];

const DEFAULTS = {
	baseUrl: "https://opencode.ai/zen/go",
	keyRef: "OPENCODE_GO_API_KEY",
	routePrefix: "/api/opencode-usage",
	cacheMs: 30000,
	timeoutMs: 15000
};

/** 三个窗口的展示顺序与中文名。 */
const WINDOWS = [
	["rolling", "滚动 5h"],
	["weekly", "本周"],
	["monthly", "本期"]
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(payload));
}

/** 每次请求都重新解析（凭据改了不用重启），解析不到就看环境变量。 */
async function resolveKey(ctx, ref) {
	try {
		const hit = await ctx.credentials.resolve(ref);
		if (hit && typeof hit.value === "string" && hit.value.length > 0) return { key: hit.value, source: hit.source || "credentials" };
	} catch (err) {
		/* 凭据服务不可用时退回环境变量 */
	}
	const env = process.env[ref];
	if (typeof env === "string" && env.length > 0) return { key: env, source: "env" };
	return null;
}

async function fetchUsage(cfg, key) {
	const url = cfg.baseUrl.replace(/\/+$/, "") + "/v1/usage";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": UA },
			signal: controller.signal
		});
		const text = await res.text();
		if (res.status === 401 || res.status === 403) throw new Error("API key 无效或订阅已失效（HTTP " + res.status + "）");
		if (!res.ok) throw new Error("上游 HTTP " + res.status + "：" + text.slice(0, 160));
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error("上游返回的不是 JSON：" + text.slice(0, 120));
		}
		const usage = json && typeof json === "object" ? (json.usage ?? json) : null;
		if (!usage || typeof usage !== "object") throw new Error("上游返回里没有 usage 字段");
		return { usage, raw: json };
	} finally {
		clearTimeout(timer);
	}
}

/** 路由和命令共用一个 30s 缓存（两边同时刷新不会把上游打爆）。 */
function createUsageReader(cfg, ctx) {
	let cache = { at: 0, fingerprint: "", usage: null, raw: null };
	return {
		async read(fresh) {
			const hit = await resolveKey(ctx, cfg.keyRef);
			if (!hit) {
				throw new Error(`没有找到凭据 ${cfg.keyRef} —— 在 ~/.dsh/.credentials.yaml 的 refs 里加一行，或设成环境变量`);
			}
			const fingerprint = hit.source + ":" + hit.key.slice(-6);
			if (!fresh && cache.usage && cache.fingerprint === fingerprint && Date.now() - cache.at < cfg.cacheMs) {
				return { usage: cache.usage, raw: cache.raw, fetchedAt: new Date(cache.at), keySource: hit.source, cached: true };
			}
			const got = await fetchUsage(cfg, hit.key);
			cache = { at: Date.now(), fingerprint, usage: got.usage, raw: got.raw };
			return { usage: cache.usage, raw: cache.raw, fetchedAt: new Date(cache.at), keySource: hit.source, cached: false };
		}
	};
}

// ── 文本渲染（给聊天命令用） ────────────────────────────────────────────────
const pad2 = (n) => (n < 10 ? "0" : "") + n;

/** 已用百分比 → 一根 20 格的小条。 */
function bar(percent, width) {
	const w = width || 20;
	const p = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = Math.round((p / 100) * w);
	return "█".repeat(filled) + "·".repeat(w - filled);
}

/** resetsAt → "10-12 21:16（还有 8 天 23 小时）"，本地时区。 */
function resetText(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	if (isNaN(d.getTime())) return "";
	const stamp = pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
	const ms = d.getTime() - Date.now();
	if (ms <= 0) return "重置 " + stamp + "（已到点）";
	const mins = Math.round(ms / 60000);
	const hrs = Math.floor(mins / 60);
	const left = hrs >= 24 ? Math.floor(hrs / 24) + " 天 " + (hrs % 24) + " 小时" : hrs > 0 ? hrs + " 小时 " + (mins % 60) + " 分" : mins + " 分";
	return "重置 " + stamp + "（还有 " + left + "）";
}

function renderUsageText(reading) {
	const now = reading.fetchedAt || new Date();
	const lines = [`**OpenCode GO 配额** · ${pad2(now.getHours())}:${pad2(now.getMinutes())}`];
	for (const [id, label] of WINDOWS) {
		const w = reading.usage ? reading.usage[id] : null;
		if (!w) { lines.push(`- **${label}** —（没有这个窗口的数据）`); continue; }
		const p = typeof w.percent === "number" ? w.percent : null;
		const hot = p !== null && p >= 80 ? " · 接近上限" : "";
		lines.push(`- **${label}** ${p === null ? "—" : p + "%"}  \`${bar(p)}\`  ${resetText(w.resetsAt)}${hot}`);
	}
	lines.push("");
	lines.push(`_官方 /zen/go/v1/usage · percent = 已用 · key 来自 ${reading.keySource || "?"}${reading.cached ? " · 30s 缓存" : ""}_`);
	return lines.join("\n");
}

/** 建路由处理器。 */
function createHandler(cfg, reader) {
	return async (req, res) => {
		const uri = new URL(req.url ?? "/", "http://x");
		const cmd = uri.pathname.slice(cfg.routePrefix.length).replace(/^\/+/, "").split("/")[0].toLowerCase();
		if (cmd === "ping") return sendJson(res, 200, { ok: true, text: "pong · POST 上游 " + cfg.baseUrl + " · keyRef " + cfg.keyRef });
		if (cmd !== "" && cmd !== "usage") return sendJson(res, 404, { ok: false, error: `unknown opencode-usage command "${cmd}"` });
		try {
			const reading = await reader.read(uri.searchParams.get("fresh") === "true");
			return sendJson(res, 200, {
				ok: true,
				usage: reading.usage,
				fetchedAt: reading.fetchedAt.toISOString(),
				keySource: reading.keySource,
				cached: reading.cached
			});
		} catch (err) {
			return sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	};
}

export function apply(ctx, config) {
	const cfg = Object.assign({}, DEFAULTS, config || {});
	const reader = createUsageReader(cfg, ctx);

	const dispose = ctx.webServer.register({ kind: "prefix", path: cfg.routePrefix, handler: createHandler(cfg, reader) });
	ctx.effect(() => dispose, "dsh-opencode-usage: route dispose");
	ctx.logger?.info?.(`dsh-opencode-usage: ${cfg.routePrefix}/usage → ${cfg.baseUrl}/v1/usage（凭据 ${cfg.keyRef}）`);

	// 聊天命令：用可选子作用域，commands 服务不在就静静跳过，不影响挂件。
	ctx.inject(["commands"], (cctx) => {
		cctx.effect(() => cctx.commands.register({
			name: "opencode-go",
			description: "OpenCode GO 套餐配额（滚动 5h / 本周 / 本期）",
			handler: async (invocation) => {
				const wantJson = /(^|\s)json(\s|$)/i.test(invocation && invocation.rawInput ? invocation.rawInput : "");
				try {
					const reading = await reader.read(wantJson);
					if (wantJson) return { kind: "success", text: "```json\n" + JSON.stringify(reading.raw, null, 2) + "\n```" };
					return { kind: "success", text: renderUsageText(reading) };
				} catch (err) {
					return { kind: "error", text: "OpenCode GO 用量读取失败：" + (err instanceof Error ? err.message : String(err)) };
				}
			}
		}), "dsh-opencode-usage: command dispose");
		cctx.logger?.info?.("dsh-opencode-usage: 已注册 /opencode-go 命令");
	});
}

export { inject, name };
