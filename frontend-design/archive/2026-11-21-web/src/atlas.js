import {graph, versions, quote} from './quotation-case.js';

const $ = id => document.getElementById(id);
const extracts = {
  taste: ['发现乐队',42,48,graph[0].text],
  instrument: ['循声寻人',32,65,'听到陌生的乐器，我会顺着去找演奏者以前的作品。'],
  verify: ['再听几天',63,37,'首页连着两天推同一类歌，我想再记一周，看看是不是一直这样。'],
  record: ['留下记录',72,31,'我把喜欢和跳过的歌都记了下来，月底一起看。'],
  choice: ['自己去找',53,64,'首页给我什么是一回事。想听什么，我会自己去搜。'],
  friend: ['朋友歌单',57,52,graph[1].text],
  share: ['互寄唱片',22,54,'每个月我都和朋友交换一张唱片，听完再聊喜欢哪一首。']
};
const traits = [
  {id:'curious',name:'好奇',x:37,y:56,refs:{taste:'他把遇见陌生乐队当作拓展口味的机会。',instrument:'陌生的音色会促使他主动追索作品。'}},
  {id:'careful',name:'审慎',x:68,y:40,refs:{verify:'他愿意延长观察，再判断变化是不是持续。',record:'喜欢与跳过的歌都记录下来，给事后判断留下依据。'}},
  {id:'autonomy',name:'看重自主选择',x:60,y:61,refs:{choice:'他区分首页呈现的内容和自己的主动选择。',instrument:'他会沿着兴趣自行寻找下一首歌。'}},
  {id:'open',name:'乐于交流',x:28,y:49,refs:{friend:'他愿意让朋友的推荐进入自己的日常聆听。',share:'持续交换唱片，也愿意听对方的感受。'}}
];
let selected=null, active=null, manual=false, layoutKey='';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const clamp=v=>Math.max(0,Math.min(1,v));
function smooth(p,a,b){const v=clamp((p-a)/(b-a));return v*v*(3-2*v)}
const buttons=new Map();
function star(id,name,x,y,minor,action){
  const button=document.createElement('button');
  button.className='starpoint'+(minor?' minor':'');
  button.dataset.star=id;button.style.left=x+'%';button.style.top=y+'%';
  const label=document.createElement('span');label.textContent=name;button.append(label);
  button.onclick=action;$('stars').append(button);buttons.set(id,button);
}
for(const t of traits){
  star(t.id,t.name,t.x,t.y,false,()=>{manual=true;selected=t;active=null;update()});
}
function wires(t){
  for(const b of $('stars').querySelectorAll('.minor')){buttons.delete(b.dataset.star);b.remove()}
  $('threads').replaceChildren();
  if(!t)return;
  for(const id of Object.keys(t.refs)){
    const [name,x,y]=extracts[id];
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    for(const [key,value] of Object.entries({x1:t.x,y1:t.y,x2:x,y2:y,pathLength:1}))line.setAttribute(key,value);
    $('threads').append(line);
    star(id,name,x,y,true,()=>{manual=true;selected=t;active=id;update()});
    buttons.get(id).style.animationDelay=(Object.keys(t.refs).indexOf(id)*120)+'ms';
  }
}
$('overview').onclick=()=>{manual=true;selected=null;active=null;update()};
const result=quote(versions.original.conflicts);
$('rate').firstChild.textContent=result.rate;
$('oldNum').textContent=result.rate;$('newNum').textContent=quote(versions.scope.conflicts).rate;
$('t1').textContent=versions.original.conflicts.length;$('t2').textContent=result.lost+' / '+result.total;
$('t3').textContent=result.dead.size-versions.original.conflicts.length;
$('t4').textContent=result.dead.size+' / '+graph.length+'（'+Math.round(result.dead.size/graph.length*100)+'%）';
$('echo').textContent='@林行　／　「'+versions.original.text+'」';
$('oldText').textContent=versions.original.text;$('say').textContent=versions.scope.text;
$('note').textContent=versions.scope.reason;
for(const [btn,key] of [['copy','scope'],['copyOld','original']]){
  $(btn).onclick=async()=>{
    try{await navigator.clipboard.writeText(versions[key].text);$('feedback').textContent=key==='scope'?'改写已复制':'原话已复制'}
    catch{const r=document.createRange();r.selectNodeContents($(key==='scope'?'say':'oldText'));getSelection().removeAllRanges();getSelection().addRange(r);$('feedback').textContent='已选中表达，可按 Ctrl+C 复制'}
  };
}
const disc=$('disc'),reading=$('reading');
let cam={x:0,y:0,z:.44},frame=0,last=0,lastBill='';
function update(){if(!frame)frame=requestAnimationFrame(paint)}
function paint(time){
  frame=0;
  const h=innerHeight,w=innerWidth,p=scrollY/h;
  const enter=smooth(p,0,1),exit=smooth(p,1.66,2.65);
  if(!manual && !selected && p>1.38){selected=traits[0];active='taste'}
  const t=selected;
  const q=active||(t&&(!manual||p>1.66)?Object.keys(t.refs)[0]:null);
  if((t?.id||'-')!==layoutKey){wires(t);layoutKey=t?.id||'-'}
  const zoom=t?1.31:1;
  const target={z:(.44+.56*enter)*(1+(zoom-1)*enter)*(1-.42*exit),x:(t?(.5-t.x/100)*disc.offsetWidth*.58:0)*enter*(1-exit),y:h*.12*(1-enter)+(t?(.5-t.y/100)*disc.offsetHeight*.55:0)*enter};
  const k=reduced.matches?1:1-Math.exp(-Math.min(50,time-last||16)/90);last=time;
  let moving=false;
  for(const key of ['x','y','z']){
    cam[key]+=(target[key]-cam[key])*k;
    if(Math.abs(cam[key]-target[key])>(key==='z'?.0003:.18))moving=true;
  }
  disc.style.transform='translate(-50%,-50%) translate('+cam.x+'px,'+cam.y+'px) scale('+cam.z+')';
  disc.style.opacity=(.72+.28*enter)*(1-.94*exit)*(1-smooth(p,2.8,3.42));
  document.querySelector('.universe').style.transform='translateY('+(-p*7)+'px)';
  const interactive=p>.68&&p<1.98;
  $('stars').style.opacity=smooth(p,.55,.9)*(1-smooth(p,1.83,2.45));
  $('stars').inert=!interactive;
  for(const [id,b] of buttons){
    b.setAttribute('aria-pressed',String(id===t?.id||id===q));
    const isOtherTrait=t && traits.some(other=>other.id===id && other!==t);
    b.style.opacity=isOtherTrait ? .38 : 1;
  }
  $('overview').hidden=!t;
  $('guide').textContent=t?'选择引文星，读他的原话':'选择一颗主星，查看他曾说过的话';
  reading.hidden=!(q&&p>.75&&p<2.52);
  if(!reading.hidden){
    const [name,,,text]=extracts[q];
    reading.children[0].textContent=t.name+'　／　'+name+' · 示例引文';
    reading.children[1].textContent='「'+text+'」';
    reading.children[2].textContent=t.refs[q];
    const rect=buttons.get(q).getBoundingClientRect();
    reading.style.left=Math.min(w-reading.offsetWidth-64,Math.max(24,rect.right+20))+'px';
    reading.style.top=Math.max(42,Math.min(h-reading.offsetHeight-72,rect.bottom+20))+'px';
    reading.style.opacity=1-smooth(p,2.22,2.52);
  }
  const billId=q||'taste';
  if(billId!==lastBill){
    const panel=$('billEvidence');panel.replaceChildren();
    function add(tag,text){const el=document.createElement(tag);el.textContent=text;panel.append(el)}
    add('small',billId==='taste'?'冲突依据 · 来自星图':'刚才读到的引文 · 背景');
    add('p','「'+extracts[billId][3]+'」');
    if(billId!=='taste'){add('small','计价所用的反例');add('p','「'+extracts.taste[3]+'」')}
    add('span','“只会变窄”与这次口味拓宽的经历冲突。报价按判断之间的支撑关系计算。');lastBill=billId;
  }
  const chapter=p<.5?0:p<2.18?1:p<3.15?2:3;
  document.querySelectorAll('.ticks a').forEach((a,i)=>a.classList.toggle('on',i===chapter));
  if(moving)update();
}
addEventListener('scroll',update,{passive:true});addEventListener('resize',update);update();
