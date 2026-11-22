import {computeGraph, collapseAfter} from './starfield.js';

/* P0 · 统一节点表
   30 条判断，同一张表同时供 buildDisc()（星图）与 quote()（账单）读取。
   字段：id / name / text / kind / deps / cluster
   - deps 严格拓扑序：只能指向更早出现的节点（computeGraph 的深度计算依赖这一点）
   - cluster：信念区编号，conflictSet() 与 price() 依赖此字段
   - S（承重）与 d（最短依赖深度）由 computeGraph 计算，不手写
   - x / y 保留给旧的二维布点；三维坐标由 orbit-system 与 structure-layout 产出

   依赖配比：25 个有依赖节点中 9 个为双依赖（36%）。
   不要把双依赖改回单依赖：塌陷规则是「存活依据/总依据 < 0.5 即塌」，
   单依赖节点一拆到底，会把报价推到 100%，数字即失去说服力。

   cluster 1 推荐确实拓宽过我 ｜ 2 选择权 ｜ 3 怎样才算数 ｜ 4 从别人那里听见
*/
const NODES = [
  // ── d=0 地基：五条亲身经历，不是命题 ───────────────────────────
  {id:'taste', name:'口味拓宽', cluster:1, deps:[], x:14, y:24,
   text:'我现在听的好几个小众乐队，都是推荐页推给我的。至少对我来说，它也拓宽过我的口味。'},
  {id:'discover', name:'推荐页的意外', cluster:1, deps:[], x:14, y:52,
   text:'有一张我那年听得最多的专辑，是推荐页随手推给我、我顺手点开的。'},
  {id:'friend', name:'朋友分享', cluster:4, deps:[], x:14, y:78,
   text:'朋友的歌单也让我喜欢上了原先不听的音乐。'},
  {id:'replay', name:'隔几天再听', cluster:3, deps:[], x:14, y:38,
   text:'有些专辑我第一遍没听出什么，隔几天再听才听进去。'},
  {id:'mixtape', name:'换歌单', cluster:4, deps:[], x:14, y:66,
   text:'我习惯跟人换歌单，顺便听听他们在里面听见了什么。'},

  // ── 第一层 ────────────────────────────────────────────────
  {id:'example', name:'推荐的反例', cluster:1, deps:['taste'], x:30, y:20,
   text:'以我自己的经历为例，推荐至少有过一次拓宽口味的作用。'},
  {id:'timbre', name:'追一个音色', cluster:1, deps:['discover'], x:30, y:50,
   text:'顺着推荐听到陌生的乐器，我会去找演奏者以前的作品。'},
  {id:'change', name:'口味可拓展', cluster:1, deps:['taste','discover'], x:30, y:34,
   text:'我的口味有过拓展的经历，而且是从推荐里来的。'},
  {id:'possible', name:'承认例外', cluster:1, deps:['example'], x:44, y:14,
   text:'讨论推荐的影响时，需要给拓宽兴趣的情形留一个位置。'},
  {id:'secondlisten', name:'听几遍不一样', cluster:3, deps:['replay'], x:30, y:40,
   text:'同一张专辑，听的次数不一样，听见的东西也不一样。'},
  {id:'slowjudge', name:'判断往后推', cluster:3, deps:['replay'], x:30, y:62,
   text:'遇到一个很像规律的现象，我习惯先留个记录，不马上下判断。'},
  {id:'swap', name:'想知道为什么', cluster:4, deps:['mixtape'], x:30, y:74,
   text:'交换歌单的时候，我更想知道对方为什么留着那首。'},
  {id:'fromothers', name:'别人带来的', cluster:4, deps:['friend','mixtape'], x:30, y:86,
   text:'我喜欢的东西里，有不少是别人带过来的。'},

  // ── 第二层 ────────────────────────────────────────────────
  {id:'digdeep', name:'顺着线索走', cluster:1, deps:['timbre','example'], x:44, y:30,
   text:'一次偶然的喜欢，常常值得我往下多走几步。'},
  {id:'widen', name:'范围在变宽', cluster:1, deps:['change','digdeep'], x:58, y:26,
   text:'这几年我听的东西，范围比以前宽。'},
  {id:'record', name:'记下听感', cluster:3, deps:['slowjudge','secondlisten'], x:44, y:52,
   text:'我会把当时的听感记下来，过后能对一对。'},
  {id:'another', name:'给另一个解释机会', cluster:3, deps:['slowjudge'], x:44, y:66,
   text:'一个解释听起来很顺的时候，我会再给另一个解释一点机会。'},
  {id:'others', name:'别人听见的不一样', cluster:4, deps:['swap','fromothers'], x:44, y:82,
   text:'别人听见的东西，常常和我听见的不是一回事。'},

  // ── 第三层 ────────────────────────────────────────────────
  {id:'notfixed', name:'口味不是定好的', cluster:1, deps:['widen'], x:70, y:24,
   text:'一个人的口味不像早就定好的，它会动。'},
  {id:'counting', name:'印象不等于规律', cluster:3, deps:['record'], x:58, y:56,
   text:'只凭印象我分不清是真有规律，还是我只记住了几次。'},
  {id:'talk', name:'聊听感更认识人', cluster:4, deps:['others'], x:58, y:84,
   text:'聊听感比互相推荐更能认识一个人。'},

  // ── 第四层 ────────────────────────────────────────────────
  {id:'choose', name:'下一首由我挑', cluster:2, deps:['notfixed'], x:80, y:30,
   text:'既然口味会动，那下一首听什么，我更希望是自己挑的。'},
  {id:'method', name:'得说清拿什么数', cluster:3, deps:['counting','another'], x:70, y:62,
   text:'要说清推荐让人变窄，得先说清拿什么来数。'},
  {id:'share', name:'讲自己绕的弯路', cluster:4, deps:['talk'], x:70, y:88,
   text:'我乐意把自己绕过的弯路讲给别人听。'},

  // ── 第五层及以上 ──────────────────────────────────────────
  {id:'handover', name:'交出去也是我决定的', cluster:2, deps:['choose'], x:88, y:22,
   text:'有时候我也愿意把选择权交给别人，但那是我决定交出去的。'},
  {id:'loop', name:'新东西会变少', cluster:2, deps:['choose','counting'], x:88, y:44,
   text:'连着点了几首相似的歌以后，推荐页里的新东西好像会变少。'},
  {id:'evidence', name:'需要更多东西', cluster:3, deps:['method','others'], x:84, y:64,
   text:'一个关于长期影响的判断，需要比我的几次经历更多的东西。'},
  {id:'agency', name:'能不能自己决定', cluster:2, deps:['handover'], x:94, y:30,
   text:'能不能自己决定，比推得准不准更要紧。'},
  {id:'worry', name:'我担心的是重复', cluster:2, deps:['loop'], x:94, y:50,
   text:'我担心的是重复，不是推荐这件事本身。'},
  {id:'notnarrow', name:'和我的经历对不上', cluster:2, deps:['worry','change'], x:94, y:40,
   text:'把推荐说成只会让人变窄，和我自己的经历对不上。'},
];

/* 主线：改造前的五条，在星图与结构态里保持高亮 */
export const SPINE = ['taste','friend','example','change','possible'];

export const graph = computeGraph(NODES.map(n => ({...n, kind:'judgment'})));

export const versions = {
  original:{
    text:'推荐算法只会让人的兴趣越来越窄。',
    conflicts:['taste','discover']
  },
  faithful:{
    text:'我的看法是，推荐算法对人的兴趣只有一种影响，就是让它越来越窄。',
    conflicts:['taste','discover'],
    reason:'保留原意 · “只有一种影响”保留了“只会”的绝对判断。林行那两次从推荐页听到新东西的经历仍是反例，换一种语气不会降低报价。'
  },
  scope:{
    text:'推荐确实能帮人发现原来没听过的乐队。我担心的是，连续点了几首相似的歌以后，推荐页里的新东西会不会越来越少。',
    conflicts:[],
    reason:'缩小主张范围 · 去掉“只会”，承认推荐也能拓宽口味。你保留了对重复推荐的担忧，而这一点林行自己也说过，所以不再撞上任何承重墙。'
  }
};

export function quote(ids){
  const dead=collapseAfter(new Set(ids),graph);
  const weight=nodes=>nodes.reduce((sum,n)=>sum+n.S,0);
  const lost=weight(graph.filter(n=>dead.has(n.id)));
  const total=weight(graph);
  return {dead,lost,total,rate:Math.round(100*lost/total)};
}
