// dsh-opencode-usage — 浏览器半边。
//
// 侧栏底部挂一个 OpenCode GO 配额小挂件（三根迷你条 + 一个百分比），点开是一张
// 浮层卡片：滚动 5h / 本周 / 本期三个窗口的进度条、重置时间和倒计时。
//
// 数据来自同源路由 /api/opencode-usage/usage（宿主半边代理到官方 /zen/go/v1/usage），
// API key 只在服务端，浏览器拿不到。
//
// NOTE 组件一律 h(Comp, props) 创建，不要直接调 Comp({...})（会把子组件 hooks 挂到父链上，
// 条件渲染时直接 React #310）。
window.__ModuleLoader__.load({
	id: "dsh-opencode-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { createElement: h, useState, useEffect, useRef, useSyncExternalStore } = react;

		// ── 主题 token（DSH 主题的 --dsw-* 别名，token 缺失时用后面的兜底值） ──
		const T = {
			layer1: "var(--dsw-alias-bg-layer-1, #ffffff)",
			layer2: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
			layer3: "var(--dsw-alias-bg-layer-3, #eceef1)",
			bd1: "var(--dsw-alias-border-l1, #e8eaed)",
			bd2: "var(--dsw-alias-border-l2, #dcdfe3)",
			fg: "var(--dsw-alias-label-primary, #1b1e21)",
			fg2: "var(--dsw-alias-label-secondary, #5b636b)",
			fg3: "var(--dsw-alias-label-tertiary, #8b939b)",
			biz: "var(--dsw-alias-state-business-primary, #3b82f6)",
			ok: "var(--dsw-alias-state-success-primary, #16a34a)",
			warn: "var(--dsw-alias-state-warn-primary, #d97706)",
			err: "var(--dsw-alias-state-error-primary, #dc2626)",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04))",
			font: "var(--ds-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif)",
			mono: "var(--ds-font-family-code, ui-monospace, Menlo, Consolas, monospace)"
		};

		// ── 图标：Lucide 内联（ISC 许可；插件 bundle 只能 require 启动图里的模块，
		//    装不了 npm 图标包，所以图标几何直接内联） ──────────────────────
		const LUCIDE = {
			activity: [
				["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]
			],
			refreshCw: [
				["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
				["path", { d: "M21 3v5h-5" }],
				["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
				["path", { d: "M8 16H3v5" }]
			],
			x: [
				["path", { d: "M18 6 6 18" }],
				["path", { d: "m6 6 12 12" }]
			]
		};

		function Icon(props) {
			const nodes = LUCIDE[props.name] || [];
			return h("svg", {
				width: props.size || 14,
				height: props.size || 14,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: props.strokeWidth || 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
				style: Object.assign({ display: "block", flex: "0 0 auto" }, props.style || {})
			}, nodes.map((node, i) => h(node[0], Object.assign({ key: i }, node[1]))));
		}

		// ── 三个窗口的展示元数据（顺序即展示顺序） ──────────────────────────
		const WINDOWS = [
			{ id: "rolling", label: "滚动 5h", short: "5h" },
			{ id: "weekly", label: "本周", short: "周" },
			{ id: "monthly", label: "本期", short: "月" }
		];

		// ── 一个极小外部 store：挂件和浮层卡片共享同一份数据，只轮询一次 ────────
		let open = false;
		const listeners = new Set();
		function subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
		function snapshot() { return state; }
		function openSnapshot() { return open; }
		function emit() { listeners.forEach((fn) => fn()); }
		function setOpen(v) { if (open !== v) { open = v; emit(); } }

		let state = { usage: null, error: null, loading: false, at: null, keySource: null };
		function setState(patch) { state = Object.assign({}, state, patch); emit(); }

		async function refresh(fresh) {
			setState({ loading: true });
			try {
				const res = await fetch("/api/opencode-usage/usage" + (fresh ? "?fresh=true" : ""), { cache: "no-store" });
				const json = await res.json();
				if (!json.ok) throw new Error(json.error || ("HTTP " + res.status));
				setState({ usage: json.usage || null, error: null, at: new Date(), keySource: json.keySource || null, loading: false });
			} catch (err) {
				setState({ error: err instanceof Error ? err.message : String(err), loading: false });
			}
		}

		let poll = null;
		function ensurePolling() {
			if (poll) return;
			poll = setInterval(() => { if (!document.hidden) refresh(false); }, 60000);
			document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
			refresh(false);
		}

		// ── 小工具 ────────────────────────────────────────────────────────────
		const pad = (n) => (n < 10 ? "0" : "") + n;
		function pctColor(p) {
			if (typeof p !== "number") return T.fg3;
			return p >= 80 ? T.err : p >= 50 ? T.warn : T.ok;
		}
		function windowOf(id) { return state.usage && state.usage[id] ? state.usage[id] : null; }
		function resetText(w) {
			if (!w || !w.resetsAt) return "";
			const d = new Date(w.resetsAt);
			if (isNaN(d.getTime())) return "";
			const ms = d.getTime() - Date.now();
			const stamp = pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
			if (ms <= 0) return "重置 " + stamp + "（已到点）";
			const mins = Math.round(ms / 60000);
			const hrs = Math.floor(mins / 60);
			const left = hrs >= 24 ? Math.floor(hrs / 24) + " 天 " + (hrs % 24) + " 小时" : hrs > 0 ? hrs + " 小时 " + (mins % 60) + " 分" : mins + " 分";
			return "重置 " + stamp + " · 还有 " + left;
		}
		function Bar(props) {
			const w = Math.max(0, Math.min(100, typeof props.percent === "number" ? props.percent : 0));
			return h("div", { style: { height: props.height || 6, borderRadius: 999, background: T.layer3, overflow: "hidden" } },
				h("div", { style: { width: (w === 0 ? 0 : Math.max(2, w)) + "%", height: "100%", background: props.color || pctColor(props.percent), borderRadius: 999, transition: "width 200ms" } })
			);
		}

		/** 挂件左侧那三根迷你条：一眼看出三个窗口谁吃紧。 */
		function MiniBars() {
			return h("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12 } },
				WINDOWS.map((win) => {
					const w = windowOf(win.id);
					const p = w && typeof w.percent === "number" ? w.percent : null;
					const height = 4 + Math.round(((p === null ? 0 : Math.min(100, p)) / 100) * 8);
					return h("span", {
						key: win.id,
						title: win.label + "：" + (p === null ? "—" : p + "%"),
						style: {
							display: "block", width: 3, height: p === null ? 4 : height, borderRadius: 2,
							background: p === null ? T.layer3 : pctColor(p), transition: "height 200ms, background 200ms"
						}
					});
				})
			);
		}

		// ── 侧栏挂件 ──────────────────────────────────────────────────────────
		function UsageWidget() {
			const [hover, setHover] = useState(false);
			const [narrow, setNarrow] = useState(false);
			const boxRef = useRef(null);
			const st = useSyncExternalStore(subscribe, snapshot);
			const isOpen = useSyncExternalStore(subscribe, openSnapshot);

			// 首次进来就拉一次，之后每 60s 一次（ensurePolling 内部去重，只会起一个定时器）
			useEffect(() => { ensurePolling(); }, []);

			useEffect(() => {
				const node = boxRef.current;
				if (!node || typeof ResizeObserver === "undefined") return undefined;
				// 判断"侧栏是不是收起了"不能量自己这边：
				//   - 祖先的宽度不变（收起只是 sidebarCol 280→56，其余被 overflow 裁掉，量不出变化）；
				//   - 量按钮/按钮里的哨兵也不行 —— 隐藏标签会让按钮变窄，而"变窄"又让判据一直成立（自锁）。
				// 所以直接盯侧栏那一栏本身：先按 CSS module 类名找，改名了就退回到
				// "第一个 overflow-x 隐藏、且宽度在 0~600 之间的祖先"（那就是 sidebarCol 的特征）。
				const measured = node.closest('[class*="sidebarCol"]') || (() => {
					let n = node.parentElement;
					while (n) {
						const cs = getComputedStyle(n);
						const w = n.getBoundingClientRect().width;
						if (cs.overflowX === "hidden" && w > 0 && w < 600) return n;
						n = n.parentElement;
					}
					return null;
				})();
				if (!measured) return undefined;
				const ro = new ResizeObserver((entries) => {
					for (const e of entries) {
						const w = e.contentRect.width;
						setNarrow((prev) => (prev ? w < 190 : w < 170));
					}
				});
				ro.observe(measured);
				return () => ro.disconnect();
			}, []);

			const monthly = windowOf("monthly");
			const p = monthly && typeof monthly.percent === "number" ? monthly.percent : null;
			const title = "OpenCode GO 配额：" + WINDOWS.map((w) => {
				const x = windowOf(w.id);
				return w.label + " " + (x && typeof x.percent === "number" ? x.percent + "%" : "—");
			}).join(" · ") + "（点击看详情）";

			return h("button", {
				ref: boxRef,
				"data-openusage-widget": "1",
				onClick: () => setOpen(!isOpen),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				title: st.error ? "OpenCode GO 用量读取失败：" + st.error : title,
				"aria-label": "OpenCode GO 配额",
				style: {
					cursor: "pointer",
					position: "relative",
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					height: 28,
					maxWidth: "100%",
					overflow: "hidden",
					border: 0,
					borderRadius: 8,
					padding: "0 8px",
					font: "500 12px/16px " + T.font,
					color: st.error ? T.err : isOpen ? T.biz : "var(--dsw-alias-label-secondary, " + T.fg2 + ")",
					background: (hover || isOpen) ? T.hover : "transparent",
					transition: "color 120ms, background 120ms"
				}
			},
				h(MiniBars, null),
				narrow ? null : h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
					st.error ? "GO ?" : "GO " + (p === null ? "…" : p + "%"))
			);
		}

		// ── 详情浮层（挂在 shell.overlay，pointer-events 只在卡片上） ────────────
		function UsageCard() {
			const isOpen = useSyncExternalStore(subscribe, openSnapshot);
			const st = useSyncExternalStore(subscribe, snapshot);
			const [hoverBtn, setHoverBtn] = useState("");
			const [anchor, setAnchor] = useState(null);
			const layerRef = useRef(null);

			// 卡片贴着挂件上方弹出（不是写死左下角）：换算成 overlay 层的相对坐标，
			// 这样侧栏展开/收起、窗口缩放都不会把卡片压到挂件身上。
			useEffect(() => {
				if (!isOpen) return undefined;
				const measure = () => {
					const widget = document.querySelector("[data-openusage-widget]");
					const layer = layerRef.current;
					if (!widget || !layer) return;
					const w = widget.getBoundingClientRect();
					const l = layer.getBoundingClientRect();
					setAnchor({
						left: Math.max(8, Math.round(w.left - l.left)),
						bottom: Math.max(8, Math.round(l.bottom - w.top + 8))
					});
				};
				measure();
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, [isOpen]);

			useEffect(() => {
				if (!isOpen) return undefined;
				const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
				const onClick = (e) => {
					// 点卡片外面就收起来（挂件自己会 toggle，所以排除它的点击）
					const el = e.target;
					if (el && el.closest && (el.closest("[data-openusage-card]") || el.closest("[data-openusage-widget]"))) return;
					setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				document.addEventListener("mousedown", onClick);
				return () => {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("mousedown", onClick);
				};
			}, [isOpen]);

			if (!isOpen) return null;

			const rows = WINDOWS.map((win) => {
				const w = windowOf(win.id);
				const p = w && typeof w.percent === "number" ? w.percent : null;
				return h("div", { key: win.id, style: { marginBottom: 12 } },
					h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 } },
						h("span", { style: { font: "600 12px/18px " + T.font, color: T.fg } }, win.label),
						h("div", { style: { flex: 1 } }),
						h("span", { style: { font: "600 14px/18px " + T.mono, color: pctColor(p) } }, p === null ? "—" : p + "%"),
						h("span", { style: { font: "400 11px/16px " + T.font, color: T.fg3 } }, "已用")
					),
					h(Bar, { percent: p, height: 7 }),
					h("div", { style: { font: "400 10.5px/16px " + T.font, color: T.fg3, marginTop: 5 } },
						resetText(w) || (w ? "" : "没有这个窗口的数据"),
						w && w.status && w.status !== "ok" ? "  · status=" + w.status : "")
				);
			});

			return h("div", {
				ref: layerRef,
				// 这一层不吃点击，只有卡片吃 —— 卡片打开时页面其它地方照常能用
				style: { position: "absolute", inset: 0, zIndex: 25, pointerEvents: "none" }
			},
				h("div", {
					"data-openusage-card": "1",
					style: {
						position: "absolute",
						left: anchor ? anchor.left : 14,
						bottom: anchor ? anchor.bottom : 56,
						width: 268, pointerEvents: "auto",
						background: T.layer1, color: T.fg,
						border: "1px solid " + T.bd2, borderRadius: 12, padding: "12px 14px 10px",
						boxShadow: "0 12px 36px rgba(0,0,0,0.26)", font: T.font
					}
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 7, marginBottom: 12 } },
						h(Icon, { name: "activity", size: 15, style: { color: T.biz } }),
						h("span", { style: { font: "600 13px/18px " + T.font } }, "OpenCode GO 配额"),
						h("div", { style: { flex: 1 } }),
						h("button", {
							onClick: () => refresh(true),
							disabled: st.loading,
							title: "重新拉一次（绕过 30s 缓存）",
							onMouseEnter: () => setHoverBtn("r"),
							onMouseLeave: () => setHoverBtn(""),
							style: {
								cursor: st.loading ? "default" : "pointer", border: 0, background: hoverBtn === "r" ? T.hover : "transparent",
								color: T.fg2, borderRadius: 6, padding: 4, opacity: st.loading ? 0.5 : 1
							}
						}, h(Icon, { name: "refreshCw", size: 13 })),
						h("button", {
							onClick: () => setOpen(false),
							title: "关闭（Esc）",
							onMouseEnter: () => setHoverBtn("x"),
							onMouseLeave: () => setHoverBtn(""),
							style: {
								cursor: "pointer", border: 0, background: hoverBtn === "x" ? T.hover : "transparent",
								color: T.fg2, borderRadius: 6, padding: 4
							}
						}, h(Icon, { name: "x", size: 13 }))
					),
					st.error
						? h("div", null,
							h("div", { style: { font: "500 11.5px/18px " + T.font, color: T.err, marginBottom: 6 } }, "取不到用量"),
							h("div", { style: { font: "400 11px/17px " + T.font, color: T.fg2, wordBreak: "break-word" } }, st.error),
							h("div", { style: { font: "400 10.5px/16px " + T.font, color: T.fg3, marginTop: 8 } },
								"宿主路由 /api/opencode-usage/usage 还没起来的话，重启一次 dsh web 就好。")
						)
						: rows,
					h("div", { style: { borderTop: "1px solid " + T.bd1, marginTop: 4, paddingTop: 8, font: "400 10px/15px " + T.font, color: T.fg3 } },
						"官方 /zen/go/v1/usage · 缓存 30s · 每 60s 自动刷新"
						+ (st.at ? " · 上次 " + pad(st.at.getHours()) + ":" + pad(st.at.getMinutes()) + ":" + pad(st.at.getSeconds()) : "")
						+ (st.keySource ? " · key 来自 " + st.keySource : "")
					)
				)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-opencode-usage",
				inject: () => ({})
			}, UsageWidget));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-opencode-usage",
				inject: () => ({})
			}, UsageCard));
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
