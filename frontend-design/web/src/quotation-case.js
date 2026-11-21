import {computeGraph, collapseAfter} from './starfield.js';

export const graph = computeGraph([
  {id:'taste', name:'口味拓宽', text:'我现在听的好几个小众乐队，都是推荐页推给我的。至少对我来说，它也拓宽过我的口味。', deps:[], x:17,y:28},
  {id:'friend', name:'朋友分享', text:'朋友的歌单也让我喜欢上了原先不听的音乐。', deps:[], x:17,y:76},
  {id:'example', name:'推荐的反例', text:'以我自己的经历为例，推荐至少有过一次拓宽口味的作用。', deps:['taste'], x:54,y:20},
  {id:'change', name:'口味可拓展', text:'我的口味有过拓展的经历。', deps:['taste','friend'], x:54,y:70},
  {id:'possible', name:'承认例外', text:'讨论推荐的影响时，需要给拓宽兴趣的情形留一个位置。', deps:['example'], x:84,y:43}
]);
export const versions = {
  original:{text:'推荐算法只会让人的兴趣越来越窄。', conflicts:['taste']},
  faithful:{text:'我的看法是，推荐算法对人的兴趣只有一种影响，就是让它越来越窄。', conflicts:['taste'], reason:'保留原意 · “只有一种影响”保留了“只会”的绝对判断。林行的亲身经历仍是反例，换一种语气不会降低报价。'},
  scope:{text:'推荐确实能帮人发现原来没听过的乐队。我担心的是，连续点了几首相似的歌以后，推荐页里的新东西会不会越来越少。', conflicts:[], reason:'缩小主张范围 · 去掉“只会”，承认推荐也能拓宽口味。你保留了对重复推荐的担忧，但放下了对人的长期兴趣的断言。林行没谈过推荐页会如何变化，这一点仍待讨论。'}
};
export function quote(ids){
  const dead=collapseAfter(new Set(ids),graph);
  const weight=nodes=>nodes.reduce((sum,n)=>sum+n.S,0);
  const lost=weight(graph.filter(n=>dead.has(n.id)));
  const total=weight(graph);
  return {dead,lost,total,rate:Math.round(100*lost/total)};
}
