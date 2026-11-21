/* P2 · 形变：星空 ⇄ 承重结构
   同一批节点，两种布局，由滚动进度连续插值。

   ⚠ 一个必须先知道的几何事实（已实测）：
   stellar-disc.js 的 project() 里有一行
       const roll = -.26, cr = Math.cos(roll), sr = Math.sin(roll);
   roll 是**硬编码常量，不属于 camera 对象**。
   所以只把 yaw→0、tilt→0.06 收敛是不够的：实测此时同层两点的屏幕连线
   仍倾斜 -14.90°，竖直立柱也偏 -14.90°（正好等于 roll 的角度）。
   建筑立面会整体歪着，"地基在下、楼层水平"读不出来。

   修法：把 roll 提升为 camera 的一个分量，形变时从 -0.26 插值到 0。
   实测插值过程：m=0 → -14.90°，m=0.5 → -7.45°，m=1 → +0.00°。
   project() 需要改成从 cam 读 roll，见本文件末尾的 INTEGRATION 说明。

   本模块只做数学，不碰 DOM、不碰 WebGL，便于独立验证。
*/

import {layoutStructure, isVirtual} from './structure-layout.js';

/* ── 常量 ─────────────────────────────────────────────────── */

/* 形变区间：第 2 屏末尾开始，第 3 屏（账单）之前完成 */
export const MORPH_FROM = 1.95;
export const MORPH_TO = 2.55;

/* 星空态的相机初值，与 sky-explorer.js 现有的 yaw=.27 / tilt=.52 一致 */
export const SKY_YAW = 0.27;
export const SKY_TILT = 0.52;
export const SKY_ROLL = -0.26;      // project() 里原本硬编码的那个值

/* 结构态的相机目标：正视立面 */
export const STRUCT_YAW = 0;
export const STRUCT_TILT = 0.06;
export const STRUCT_ROLL = 0;       // 必须归零，否则楼是歪的

/* 星云退场深度。装饰不能和数据点处在同一亮度区间 */
export const VEIL_FLOOR = 0.12;     // 1 - 0.88

/* 形变完成后停止累加 simTime 的阈值 */
export const FREEZE_AT = 0.995;

/* 交互开关的上界。原值 2.02 会让结构态不可点选 */
export const ENABLED_FROM = 0.7;
export const ENABLED_TO = 3.3;

/* ── 基础函数 ─────────────────────────────────────────────── */

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/** smoothstep，与 sky-explorer.js 现有的 fade() 同形，便于直接复用 */
export function fade(p, a, b) {
  const t = clamp((p - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 形变量 m：0 = 纯星空，1 = 纯结构 */
export function morphAmount(p) {
  return fade(p, MORPH_FROM, MORPH_TO);
}

/** 结构态是否已定格（用于停止 simTime 累加，避免无意义抖动） */
export function isFrozen(m) {
  return m > FREEZE_AT;
}

/** 交互是否开启。上界放宽到 3.3，让用户在结构态里也能点选节点 */
export function isEnabled(p) {
  return p > ENABLED_FROM && p < ENABLED_TO;
}

/** 星云遮罩：随形变退到 VEIL_FLOOR，让气体云变成背景 */
export function veilAmount(m) {
  return 1 - (1 - VEIL_FLOOR) * clamp(m, 0, 1);
}

/* ── 相机 ─────────────────────────────────────────────────── */

/**
 * 形变过程中的相机目标。
 * yaw / tilt / roll 三者同步收敛，roll 必须参与，否则立面是歪的。
 * @param {number} m 形变量 0..1
 * @param {number} userYaw 用户拖拽累积的 yaw
 * @param {number} userTilt 用户拖拽累积的 tilt
 */
export function cameraTarget(m, userYaw = SKY_YAW, userTilt = SKY_TILT) {
  const k = clamp(m, 0, 1);
  return {
    yaw: userYaw * (1 - k) + STRUCT_YAW * k,
    tilt: userTilt * (1 - k) + STRUCT_TILT * k,
    roll: SKY_ROLL * (1 - k) + STRUCT_ROLL * k,
  };
}

/**
 * 拖拽旋转的可用范围随 m 收窄：结构态下几乎锁死，避免把立面转歪。
 * 返回一个 0..1 的系数，乘到 pointermove 的 dx/dy 增量上。
 */
export function dragGain(m) {
  return Math.pow(1 - clamp(m, 0, 1), 1.5);
}

/* ── 坐标插值 ─────────────────────────────────────────────── */

/**
 * 预解算结构态坐标。对同一份 graph 只需调用一次。
 * 返回的 Map 含真实节点与长边支点（支点 id 以 ~ 开头）。
 */
export function prepareStructure(graph) {
  return layoutStructure(graph);
}

/**
 * 把一颗星的坐标从轨道态插值到结构态。
 * orbit 侧照常由 advance(simTime) 演算，这里只做混合，权重为 (1-m)。
 *
 * @param {Array} orbitCoord advance() 写入的 [x,y,z]
 * @param {Array} structCoord layoutStructure() 给出的 [x,y,z]
 * @param {number} m 形变量
 * @param {Array} out 就地写入的目标数组（通常就是 star.coord）
 */
export function blendCoord(orbitCoord, structCoord, m, out) {
  const k = clamp(m, 0, 1);
  const target = out || [0, 0, 0];
  if (!structCoord) {
    target[0] = orbitCoord[0]; target[1] = orbitCoord[1]; target[2] = orbitCoord[2];
    return target;
  }
  target[0] = orbitCoord[0] + (structCoord[0] - orbitCoord[0]) * k;
  target[1] = orbitCoord[1] + (structCoord[1] - orbitCoord[1]) * k;
  target[2] = orbitCoord[2] + (structCoord[2] - orbitCoord[2]) * k;
  return target;
}

/**
 * 批量混合：遍历星表，把每颗星的 coord 就地更新。
 * 星表里没有对应结构坐标的（例如装饰星）保持轨道位置不动。
 */
export function blendAll(stars, structure, m, orbitCache) {
  for (const star of stars) {
    const orbit = orbitCache ? orbitCache.get(star.id) : star.coord;
    blendCoord(orbit, structure.get(star.id), m, star.coord);
  }
}

/* ── 可见性曲线 ───────────────────────────────────────────── */

/**
 * #disc 的不透明度。
 * 原实现用 exit = fade(p, 1.72, 2.65) 让圆盘在账单屏之前淡出，
 * 结构态需要在第 3 屏保持可见，所以这条曲线必须重写：
 * 进场照常，形变段保持全可见，直到第 4 屏才退场。
 */
export function discOpacity(p) {
  const enter = fade(p, 0, 1);
  const leave = fade(p, 3.25, 3.75);
  return (0.74 + 0.26 * enter) * (1 - leave);
}

/* ── 调试 ─────────────────────────────────────────────────── */

/**
 * 读取 ?m= 强制形变量，便于截图核对中间态。
 * 返回 null 表示未指定，应按滚动进度计算。
 */
export function debugMorph(search) {
  const raw = new URLSearchParams(search || '').get('m');
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? clamp(v, 0, 1) : null;
}

/** 当前帧的形变量：优先 ?m=，否则按滚动进度 */
export function resolveMorph(p, search) {
  const forced = debugMorph(search);
  return forced === null ? morphAmount(p) : forced;
}

export {isVirtual};

/* ── INTEGRATION ───────────────────────────────────────────
   接入 sky-explorer.js / stellar-disc.js 的改动点：

   1. stellar-disc.js 的 project()
      把
          const roll = -.26, cr = Math.cos(roll), sr = Math.sin(roll);
      改成从相机读取
          const roll = cam.roll ?? -.26;
          const cr = Math.cos(roll), sr = Math.sin(roll);
      并在 camera 初值里加 roll: SKY_ROLL。
      不改这一处，结构态立面会固定歪 14.90°。

   2. sky-explorer.js 的 camera 对象
      新增 roll 分量，纳入既有的指数平滑循环
          for (const name of Object.keys(camera)) camera[name] += (target[name]-camera[name])*k;
      roll 会自动跟着插值，不需要额外代码。

   3. paint() 内，advance(simTime) 之后
          const m = resolveMorph(p, location.search);
          if (!isFrozen(m)) { ...原有 simTime 累加... }
          blendAll(catalog.stars, structure, m, orbitCache);
      orbitCache 保存 advance() 刚写出的轨道坐标，供下一帧继续插值。

   4. 相机目标
          const cam = cameraTarget(m, yaw, tilt);
          const target = {...cam, zoom: ..., x: ..., y: ..., z: ..., offset: ...};

   5. 拖拽增量乘 dragGain(m)
          if (press.drag) { yaw = press.yaw + dx*.005*dragGain(m); ... }

   6. enabled 用 isEnabled(p) 替换原来的 p>.7 && p<2.02

   7. #disc 不透明度用 discOpacity(p) 替换原来含 exit 的表达式

   8. galaxy3d 的 uVeil 传 veilAmount(m)
   ─────────────────────────────────────────────────────────── */
