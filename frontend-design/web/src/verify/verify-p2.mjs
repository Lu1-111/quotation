/* P2 验收脚本：形变
   运行：node quotation-p0/verify-p2.mjs

   重点是相机几何：结构态必须正视，立面不能歪。
   project() 的复刻严格照 stellar-disc.js 原文，只把 roll 改为从 cam 读取。 */

import {graph} from '../quotation-case.js';
import {isVirtual} from '../structure-layout.js';
import {
  morphAmount, resolveMorph, debugMorph, fade,
  cameraTarget, dragGain, veilAmount, discOpacity,
  isFrozen, isEnabled, prepareStructure, blendCoord, blendAll,
  MORPH_FROM, MORPH_TO, SKY_YAW, SKY_TILT, SKY_ROLL, STRUCT_ROLL, VEIL_FLOOR,
} from '../structure-morph.js';

const pass = [], fail = [];
const check = (ok, name, detail) => (ok ? pass : fail).push(`${name} — ${detail}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ── project() 复刻：唯一改动是 roll 从 cam 读取 ──────────── */
function project(coord, cam, w = 1440, h = 900) {
  const cs = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
  const ct = Math.cos(cam.tilt), st = Math.sin(cam.tilt);
  const roll = cam.roll ?? -0.26;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const extent = Math.min(w * 0.445, h * 0.75) * (cam.zoom ?? 1);
  const x = coord[0] - (cam.x ?? 0), y = coord[1] - (cam.y ?? 0), z = coord[2] - (cam.z ?? 0);
  const u = x * cs - z * sn, v = x * sn + z * cs;
  const up = v * st - y * ct, depth = v * ct + y * st;
  const perspective = 3.9 / (3.9 - depth);
  return {
    sx: w * 0.5 + (u * cr - up * sr) * extent * perspective,
    sy: h * (0.5 + (cam.offset ?? 0)) + (u * sr + up * cr) * extent * perspective,
  };
}
const deg = r => r * 180 / Math.PI;

/* ── 形变量曲线 ───────────────────────────────────────────── */
console.log('=== 形变量 m 随滚动进度 ===');
for (const p of [0, 1.0, 1.95, 2.1, 2.25, 2.4, 2.55, 3.0]) {
  const m = morphAmount(p);
  console.log(`  p=${p.toFixed(2)}  m=${m.toFixed(4)}${p <= MORPH_FROM ? '  (星空态)' : p >= MORPH_TO ? '  (结构态)' : ''}`);
}
check(near(morphAmount(MORPH_FROM), 0), '形变起点', `p=${MORPH_FROM} 时 m=0，第 2 屏不受影响`);
check(near(morphAmount(MORPH_TO), 1), '形变终点', `p=${MORPH_TO} 时 m=1，进入账单屏前完成`);
check(near(morphAmount(2.25), 0.5, 0.02), '中点平滑', `p=2.25 时 m≈${morphAmount(2.25).toFixed(3)}，smoothstep 无跳变`);
let mono = true;
for (let p = 1.9; p <= 2.6; p += 0.01)
  if (morphAmount(p + 0.01) < morphAmount(p) - 1e-12) mono = false;
check(mono, '形变单调', 'm 随滚动单调不回弹');

/* ── 相机几何：结构态必须正视 ─────────────────────────────── */
console.log('\n=== 相机几何（关键）===');
console.log('  m      yaw     tilt    roll    同层连线倾角   竖柱偏角');
const rows = [];
for (const m of [0, 0.25, 0.5, 0.75, 1]) {
  const cam = {...cameraTarget(m), zoom: 1};
  const a = project([-0.5, -0.95, 0], cam), b = project([0.5, -0.95, 0], cam);
  const c = project([0, -0.95, 0], cam), d = project([0, 0.95, 0], cam);
  const level = deg(Math.atan2(b.sy - a.sy, b.sx - a.sx));
  const col = deg(Math.atan2(d.sx - c.sx, c.sy - d.sy));
  rows.push({m, cam, level, col});
  console.log(`  ${m.toFixed(2)}  ${cam.yaw.toFixed(3)}  ${cam.tilt.toFixed(3)}  ${cam.roll.toFixed(3)}  ${level.toFixed(2).padStart(10)}°  ${col.toFixed(2).padStart(10)}°`);
}
const last = rows[rows.length - 1];
check(near(last.cam.roll, STRUCT_ROLL, 1e-9), 'roll 归零', `m=1 时 roll=${last.cam.roll.toFixed(6)}（project() 原本硬编码 ${SKY_ROLL}）`);
check(Math.abs(last.level) < 0.01, '楼层水平', `m=1 时同层连线倾角 ${last.level.toFixed(4)}°`);
check(Math.abs(last.col) < 0.01, '立柱垂直', `m=1 时竖柱偏角 ${last.col.toFixed(4)}°`);
/* m=0 必须与改造前完全一致。
   注意不能用"同层倾角 = -14.90°"来断言：那只在 yaw=0 时成立。
   星空态 yaw=0.27/tilt=0.52 下，同层连线还被 yaw/tilt 一起旋转，
   实测倾角是 -4.54°，而竖柱偏角才是 -14.90°。
   这里直接比对相机三个分量，不绕道几何量。 */
const cam0 = cameraTarget(0);
check(near(cam0.yaw, SKY_YAW) && near(cam0.tilt, SKY_TILT) && near(cam0.roll, SKY_ROLL),
  '星空态保持原样',
  `m=0 时 yaw/tilt/roll = ${cam0.yaw}/${cam0.tilt}/${cam0.roll}，与改造前完全一致`);
check(Math.abs(rows[0].col + 14.9) < 0.1, '星空态竖柱偏角',
  `m=0 时竖柱偏角 ${rows[0].col.toFixed(2)}°，等于 project() 原本的 roll`);

// 若不修 roll（保持硬编码 -0.26），验证确实会歪
const camNoRoll = {yaw: 0, tilt: 0.06, roll: SKY_ROLL, zoom: 1};
const a2 = project([-0.5, -0.95, 0], camNoRoll), b2 = project([0.5, -0.95, 0], camNoRoll);
const tiltOnly = deg(Math.atan2(b2.sy - a2.sy, b2.sx - a2.sx));
console.log(`\n  对照：只收敛 yaw/tilt 而不动 roll → 同层倾角 ${tiltOnly.toFixed(2)}°（立面歪着）`);
check(Math.abs(tiltOnly) > 10, 'roll 修正必要性', `仅改 yaw/tilt 时仍歪 ${tiltOnly.toFixed(2)}°，证明 roll 必须参与插值`);

/* ── 坐标插值 ─────────────────────────────────────────────── */
const structure = prepareStructure(graph);
const orbit = new Map(graph.map((n, i) => [n.id, [Math.cos(i) * 0.75, Math.sin(i) * 0.3, Math.sin(i * 2) * 0.2]]));
const stars = graph.map(n => ({id: n.id, coord: [...orbit.get(n.id)]}));

console.log('\n=== 坐标插值 ===');
blendAll(stars, structure, 0, orbit);
let sameAsOrbit = stars.every(s => {
  const o = orbit.get(s.id);
  return near(s.coord[0], o[0]) && near(s.coord[1], o[1]) && near(s.coord[2], o[2]);
});
check(sameAsOrbit, 'm=0 等于轨道态', '形变量为 0 时坐标与 advance() 的输出完全一致');

blendAll(stars, structure, 1, orbit);
let sameAsStruct = stars.every(s => {
  const t = structure.get(s.id);
  return t ? near(s.coord[0], t[0]) && near(s.coord[1], t[1]) && near(s.coord[2], t[2]) : true;
});
check(sameAsStruct, 'm=1 等于结构态', '形变量为 1 时坐标与 layoutStructure() 完全一致');

blendAll(stars, structure, 0.5, orbit);
const mid = stars[0], o0 = orbit.get(mid.id), s0 = structure.get(mid.id);
console.log(`  m=0.5 样本 ${mid.id}: 轨道 ${o0.map(v=>v.toFixed(2)).join(',')} → 结构 ${s0.map(v=>v.toFixed(2)).join(',')} → 当前 ${mid.coord.map(v=>v.toFixed(2)).join(',')}`);
check(near(mid.coord[1], (o0[1] + s0[1]) / 2, 1e-9), 'm=0.5 线性混合', '中间态为两端的算术中点');

// 没有结构坐标的装饰星应保持轨道位置
const deco = {id: '__deco__', coord: [0.5, 0.5, 0.5]};
blendCoord([0.5, 0.5, 0.5], structure.get('__deco__'), 1, deco.coord);
check(near(deco.coord[0], 0.5) && near(deco.coord[1], 0.5), '装饰星不受影响', '星表中无结构坐标的点保持轨道位置');

/* 结构态下 z 应当接近 0（立面平整，只留微抖动） */
blendAll(stars, structure, 1, orbit);
const maxZ = Math.max(...stars.map(s => Math.abs(s.coord[2])));
check(maxZ <= 0.04, '结构态 z 平整', `最大 |z| = ${maxZ.toFixed(4)}，立面平整`);

/* ── 定格、交互、星云、可见性 ─────────────────────────────── */
console.log('\n=== 其他曲线 ===');
console.log(`  isFrozen: m=0.99→${isFrozen(0.99)}  m=0.996→${isFrozen(0.996)}`);
check(!isFrozen(0.99) && isFrozen(0.996), '结构态定格', 'm>0.995 时停止 simTime 累加，避免无意义抖动');

console.log(`  isEnabled: p=0.5→${isEnabled(0.5)}  p=2.5→${isEnabled(2.5)}  p=3.2→${isEnabled(3.2)}  p=3.4→${isEnabled(3.4)}`);
check(isEnabled(2.5) && isEnabled(3.2), '结构态可点选', '交互上界放宽到 3.3，账单屏仍可拾取节点（原为 2.02）');

console.log(`  veilAmount: m=0→${veilAmount(0).toFixed(2)}  m=0.5→${veilAmount(0.5).toFixed(2)}  m=1→${veilAmount(1).toFixed(2)}`);
check(near(veilAmount(0), 1) && near(veilAmount(1), VEIL_FLOOR), '星云退场', `m=1 时 uVeil=${VEIL_FLOOR}，气体云退成背景`);

console.log(`  dragGain: m=0→${dragGain(0).toFixed(2)}  m=0.5→${dragGain(0.5).toFixed(2)}  m=1→${dragGain(1).toFixed(2)}`);
check(near(dragGain(0), 1) && near(dragGain(1), 0), '拖拽收窄', '结构态锁死旋转，防止用户把立面转歪');

const discVals = [0, 1, 2, 2.5, 3.0, 3.25, 3.5, 3.75].map(p => `p=${p}:${discOpacity(p).toFixed(2)}`);
console.log(`  discOpacity ${discVals.join('  ')}`);
check(discOpacity(2.5) > 0.9 && discOpacity(3.0) > 0.9, '结构态可见', `原 exit=fade(p,1.72,2.65) 会在账单屏前淡出；新曲线 p=3.0 时仍为 ${discOpacity(3.0).toFixed(2)}`);
check(discOpacity(3.75) < 0.01, '第 4 屏退场', `p=3.75 时 ${discOpacity(3.75).toFixed(3)}`);

/* ── 调试参数 ─────────────────────────────────────────────── */
console.log('\n=== 调试参数 ?m= ===');
check(debugMorph('?m=0') === 0 && debugMorph('?m=1') === 1 && debugMorph('?m=0.5') === 0.5,
  '?m= 可用', '强制形变量用于截图核对中间态');
check(debugMorph('') === null && debugMorph('?s=2') === null, '?m= 缺省', '未指定时返回 null，按滚动进度计算');
check(debugMorph('?m=5') === 1 && debugMorph('?m=-3') === 0, '?m= 越界夹取', '超出 0..1 的输入被夹到边界');
check(resolveMorph(0, '?m=1') === 1 && near(resolveMorph(2.55, ''), 1), 'resolveMorph 优先级', '?m= 覆盖滚动进度');
check(debugMorph('?m=abc') === null, '?m= 非法输入', '非数值返回 null 而不是 NaN');

/* ── 与 P1 的一致性 ───────────────────────────────────────── */
const realCount = [...structure.keys()].filter(id => !isVirtual(id)).length;
check(realCount === graph.length, '结构坐标完整', `${realCount}/${graph.length} 个真实节点有结构态目标坐标`);

/* ── 汇总 ───────────────────────────────────────────────── */
console.log(`\n=== 汇总：${pass.length} 项通过，${fail.length} 项未通过 ===`);
for (const p of pass) console.log(`  [通过] ${p}`);
for (const f of fail) console.log(`  [未过] ${f}`);
process.exit(fail.length ? 1 : 0);
