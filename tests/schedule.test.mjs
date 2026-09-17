// 排程引擎测试：用伪 DOM 加载 index.html 内联脚本，验证排产规则。
// 运行：node tests/schedule.test.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

function fakeEl() {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === "addEventListener") return () => {};
      if (k === "value" || k === "innerHTML" || k === "textContent") return "";
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); }
  });
}

function load(store = {}) {
  const context = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: { querySelector: () => fakeEl(), createElement: () => fakeEl() },
    window: {},
    crypto,
    prompt: () => null,
    confirm: () => true,
    Blob: class {},
    URL: { createObjectURL: () => "", revokeObjectURL: () => {} }
  };
  const fn = new Function(...Object.keys(context), code + `
    ;return {
      get works() { return works; }, set works(v) { works = v; },
      get schedule() { return schedule; },
      stagesFor, placeWork, ensureSchedule, simulateInsert, conflictReason, workLate,
      addWorkWithCheck, buildOccupancy, planValid, prioCompare, replanAll,
      updateStatus, recordDefect, todayStr, addDays, diffDays
    };`);
  return { app: fn(...Object.values(context)), store };
}

function mk(app, over = {}) {
  return {
    id: crypto.randomUUID(),
    base: "木胎", theme: "测试纹", line: "细线", progress: 100,
    dryDate: app.todayStr(), gold: "未处理", defect: "",
    delivery: app.addDays(app.todayStr(), 5), status: "待阴干",
    note: "", logs: ["测试创建"],
    ...over
  };
}

function allDates(p) {
  return [...(p.thread || []), ...(p.dry || []), ...(p.gold ? [p.gold] : [])];
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. 种子数据：全部未交付作品都有合法排程，产能不超限
{
  const { app } = load();
  const today = app.todayStr();
  assert.equal(app.works.length, 4);
  const active = app.works.filter(w => w.status !== "待交付");
  for (const w of active) {
    const p = app.schedule.plans[w.id];
    assert.ok(p, `缺少排程：${w.theme}`);
    for (const d of allDates(p)) assert.ok(d >= today, `${w.theme} 排到了过去`);
    if (p.dry) assert.equal(app.addDays(p.dry[0], 1), p.dry[1], "阴干必须连续两天");
    if (p.dry && p.gold) assert.ok(p.gold > p.dry[1], "上金粉必须在阴干之后");
    if (p.thread.length && p.dry) assert.ok(p.dry[0] > p.thread[p.thread.length - 1], "阴干必须在贴线之后");
  }
  const occ = app.buildOccupancy(app.schedule.plans, null);
  for (const [d, ids] of Object.entries(occ.dry)) assert.ok(ids.length <= 2, `阴干超限 ${d}`);
  for (const [d, ids] of Object.entries(occ.gold)) assert.ok(ids.length <= 1, `上金粉超限 ${d}`);
  const overdue = app.works.find(w => w.delivery < today);
  assert.ok(overdue, "种子数据应包含已超期作品");
  assert.ok(app.workLate(overdue), "已超期作品应被标记");
  test("种子数据排程合法且产能不超限", () => {});
}

// 2. 全部重排：超期 > 缺陷 > 交付先后
{
  const { app } = load();
  app.works = [
    mk(app, { theme: "普通件", status: "上金粉", gold: "试扫粉", delivery: app.addDays(app.todayStr(), 5) }),
    mk(app, { theme: "超期件", status: "上金粉", gold: "试扫粉", delivery: app.addDays(app.todayStr(), -1) }),
    mk(app, { theme: "缺陷件", status: "上金粉", gold: "试扫粉", defect: "断线", delivery: app.addDays(app.todayStr(), 4) })
  ];
  app.replanAll();
  const goldOf = Object.fromEntries(app.works.map(w => [w.theme, app.schedule.plans[w.id].gold]));
  assert.ok(goldOf["超期件"] < goldOf["缺陷件"], "超期件应排在缺陷件前");
  assert.ok(goldOf["缺陷件"] < goldOf["普通件"], "缺陷件应排在普通件前");
  test("全部重排按 超期→缺陷→交付 优先级", () => {});
}

// 3. 插单冲突：不满足承诺时不加入、给出原因；强制加入后现有排程不变、承诺日期不变
{
  const { app } = load();
  const before = JSON.parse(JSON.stringify(app.schedule.plans));
  const rush = mk(app, { theme: "插单急件", status: "待阴干", delivery: app.todayStr() });
  const res = app.addWorkWithCheck(rush);
  assert.equal(res.added, false, "冲突时不应直接加入");
  assert.equal(res.late, true);
  assert.ok(res.sim.reason.includes("阴干"), `原因应说明阴干产能：${res.sim.reason}`);
  assert.ok(!app.works.some(w => w.id === rush.id), "未确认前不应入库");

  const res2 = app.addWorkWithCheck(rush, true);
  assert.ok(res2.added);
  for (const [id, p] of Object.entries(before)) {
    assert.deepEqual(app.schedule.plans[id], p, `插单不得改动已承诺订单的排程 ${id}`);
  }
  const saved = app.works.find(w => w.id === rush.id);
  assert.equal(saved.delivery, rush.delivery, "交付承诺不得被静默修改");
  assert.deepEqual(app.schedule.plans[rush.id], res2.sim.plan, "模拟结果应与实际排程一致");
  assert.ok(app.workLate(saved), "插单应被标记为超承诺");
  test("插单冲突处理与已承诺订单保护", () => {});
}

// 4. 可满足承诺的插单直接排入
{
  const { app } = load();
  const ok = mk(app, { theme: "从容件", status: "待阴干", delivery: app.addDays(app.todayStr(), 6) });
  const res = app.addWorkWithCheck(ok);
  assert.ok(res.added, "可满足承诺的插单应直接加入");
  assert.equal(res.late, false);
  assert.ok(app.schedule.plans[ok.id].done <= ok.delivery);
  test("可满足承诺的插单直接排入", () => {});
}

// 5. 刷新保留：同一份 localStorage 重新加载后排程一致
{
  const store = {};
  const a = load(store).app;
  a.addWorkWithCheck(mk(a, { theme: "留存件" }), true);
  const plansA = a.schedule.plans;
  const b = load(store).app;
  assert.deepEqual(b.schedule.plans, plansA, "刷新后排程应保留");
  assert.equal(b.works.length, a.works.length, "作品数据应保留");
  test("排程与作品数据刷新后保留", () => {});
}

// 6. 状态流转只重排受影响的作品
{
  const { app } = load();
  const target = app.works.find(w => w.status === "贴线中");
  const before = { ...app.schedule.plans };
  const others = Object.fromEntries(Object.entries(before).filter(([id]) => id !== target.id));
  app.updateStatus(target.id, "待阴干");
  const after = app.schedule.plans;
  for (const [id, p] of Object.entries(others)) {
    assert.deepEqual(after[id], p, `其他作品排程不应被状态流转影响 ${id}`);
  }
  assert.ok(after[target.id].dry && after[target.id].dry.length === 2, "转为待阴干后应有两天阴干");
  app.updateStatus(target.id, "待交付");
  assert.ok(!app.schedule.plans[target.id], "待交付作品不再占用排程");
  test("状态流转触发增量重排", () => {});
}

// 7. 产能压力：6 件同时待阴干，每天阴干≤2、上金粉≤1
{
  const { app } = load();
  app.works = Array.from({ length: 6 }, (_, i) => mk(app, { theme: `件${i}` }));
  app.replanAll();
  assert.equal(Object.keys(app.schedule.plans).length, 6);
  const occ = app.buildOccupancy(app.schedule.plans, null);
  for (const [d, ids] of Object.entries(occ.dry)) assert.ok(ids.length <= 2, `阴干超限 ${d}`);
  for (const [d, ids] of Object.entries(occ.gold)) assert.ok(ids.length <= 1, `上金粉超限 ${d}`);
  const dones = app.works.map(w => app.schedule.plans[w.id].done);
  assert.ok(Math.max(...dones.map(d => app.diffDays(app.todayStr(), d))) >= 5, "产能受限时应自然顺延");
  test("产能上限在高压下仍然成立", () => {});
}

// 8. 贴线进度换算：剩余 60% 需要 2 天贴线
{
  const { app } = load();
  const w = mk(app, { status: "贴线中", progress: 40 });
  const stages = app.stagesFor(w);
  assert.equal(stages[0].days, 2, "剩余60%按每天50%应排2天贴线");
  assert.deepEqual(stages.map(s => s.type), ["thread", "dry", "gold"]);
  test("贴线进度换算为工序天数", () => {});
}

console.log(`\n${passed} 项测试全部通过`);
