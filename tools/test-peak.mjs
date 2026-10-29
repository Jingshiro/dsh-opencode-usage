// 峰谷/节假日纯逻辑的单元测试。
// 做法：把 client.js 里 /* peak-logic:start */…/* peak-logic:end */ 这一整段
// 抽出来，在 node 里用 new Function 跑——不引入 React/DOM，也不用起浏览器。
//
//   node tools/test-peak.mjs
//
// 时间一律用 Date.UTC(y, m-1, d, h-8, min) 表示「北京时间某点」。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const start = src.indexOf("/* peak-logic:start */");
const end = src.indexOf("/* peak-logic:end */");
if (start < 0 || end < 0) {
	console.error("找不到 peak-logic 标记，client.js 结构变了？");
	process.exit(2);
}
const block = src.slice(start, end);

const api = new Function(block + "\nreturn { setHolidayDays, holidayAt, isPeakAt, nextSwitchAt, bjDateKey, MAKEUP_WORKDAY_IS_PEAK };")();

/** 北京时间 → 毫秒。 */
const bj = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm);

let failed = 0;
function check(name, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed += 1;
	console.log((ok ? "  ok  " : "  FAIL") + "  " + name + (ok ? "" : "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
}

const DAY = 24 * 3600 * 1000;

console.log("\n[1] 没有日历时的基准行为（纯工作日/周末）");
api.setHolidayDays([]);
check("周四 10:00 是峰", api.isPeakAt(bj(2026, 10, 29, 10)), true);
check("周四 08:30 是谷", api.isPeakAt(bj(2026, 10, 29, 8, 30)), false);
check("周四 12:30 是谷（午间空档）", api.isPeakAt(bj(2026, 10, 29, 12, 30)), false);
check("周四 14:00 是峰", api.isPeakAt(bj(2026, 10, 29, 14)), true);
check("周四 18:00 是谷（右开区间）", api.isPeakAt(bj(2026, 10, 29, 18)), false);
check("周六 10:00 是谷", api.isPeakAt(bj(2026, 10, 31, 10)), false);
check("周日 15:00 是谷", api.isPeakAt(bj(2026, 11, 1, 15)), false);
check("北京日期键", api.bjDateKey(bj(2026, 10, 30, 0, 30)), "2026-10-30");

console.log("\n[2] 法定节假日（isOffDay=true）按谷期算");
api.setHolidayDays([
	{ date: "2026-10-01", name: "国庆节", off: true }, // 周四
	{ date: "2026-10-02", name: "国庆节", off: true } // 周五
]);
check("10-01 周四 10:00 → 谷（国庆）", api.isPeakAt(bj(2026, 10, 1, 10)), false);
check("10-02 周五 15:00 → 谷（国庆）", api.isPeakAt(bj(2026, 10, 2, 15)), false);
check("节假日名字能取到", api.holidayAt(bj(2026, 10, 1, 9))?.name, "国庆节");
check("非节假日不受影响（10-08 周四 10:00）", api.isPeakAt(bj(2026, 10, 8, 10)), true);

console.log("\n[3] 调休上班日（isOffDay=false）：默认仍是谷期");
check("MAKEUP_WORKDAY_IS_PEAK 默认 false", api.MAKEUP_WORKDAY_IS_PEAK, false);
api.setHolidayDays([{ date: "2026-10-10", name: "国庆节", off: false }]); // 周六
check("10-10 周六 10:00 → 谷（保持周末口径）", api.isPeakAt(bj(2026, 10, 10, 10)), false);

console.log("\n[4] 下一次切换：长假也能跨过去");
// 国庆 10-01..10-07 全放假，从 10-01 10:00 开始算，下一次「变回峰期」应是 10-08 09:00
const week = [];
for (let d = 1; d <= 7; d += 1) week.push({ date: "2026-10-0" + d, name: "国庆节", off: true });
api.setHolidayDays(week);
const from = bj(2026, 10, 1, 10);
const nextSw = api.nextSwitchAt(from);
check("从 10-01 10:00 起下一次切换 = 10-08 09:00", api.bjDateKey(nextSw) + " " + new Date(nextSw + 8 * 3600e3).toISOString().slice(11, 16), "2026-10-08 09:00");
check("间隔 6 天 23 小时（10:00 → 次日 09:00）", nextSw - from, 7 * DAY - 3600 * 1000);

console.log("\n[5] 普通日子：峰期里下一次切换是同一天 18:00 / 12:00");
api.setHolidayDays([]);
check("周四 10:00 → 12:00", api.nextSwitchAt(bj(2026, 10, 29, 10)) - bj(2026, 10, 29, 10), 2 * 3600 * 1000);
check("周四 15:30 → 18:00", api.nextSwitchAt(bj(2026, 10, 29, 15, 30)) - bj(2026, 10, 29, 15, 30), 2.5 * 3600 * 1000);
check("周五 17:00 → 当天 18:00（转谷）", api.bjDateKey(api.nextSwitchAt(bj(2026, 10, 30, 17))) + " " + new Date(api.nextSwitchAt(bj(2026, 10, 30, 17)) + 8 * 3600e3).toISOString().slice(11, 16), "2026-10-30 18:00");
check("周五 19:00 → 下周一 09:00（跨周末）", api.bjDateKey(api.nextSwitchAt(bj(2026, 10, 30, 19))) + " " + new Date(api.nextSwitchAt(bj(2026, 10, 30, 19)) + 8 * 3600e3).toISOString().slice(11, 16), "2026-11-02 09:00");

console.log(failed === 0 ? "\n全部通过。" : "\n有 " + failed + " 条失败。");
process.exit(failed === 0 ? 0 : 1);
