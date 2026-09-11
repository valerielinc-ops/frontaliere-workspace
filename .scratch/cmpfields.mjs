import { execFileSync } from 'node:child_process';
const repo='/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no';
const load=(ref)=>{
  const tree=execFileSync('git',['ls-tree',ref,'data/jobs/by-crawler/'],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});
  const entries=tree.trimEnd().split('\n').filter(Boolean).map(l=>{const[m]=l.split('\t');const[,t,sha]=m.split(/\s+/);return{t,sha};}).filter(e=>e.t==='blob');
  const map=new Map();
  for(const e of entries){ let raw; try{raw=execFileSync('git',['cat-file','blob',e.sha],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});}catch{continue;}
    let d; try{d=JSON.parse(raw);}catch{continue;}
    if(!d||Array.isArray(d)||!Array.isArray(d.jobs))continue;
    for(const j of d.jobs){ if(!j||typeof j!=='object'||!j.id)continue;
      map.set(j.id,{title:String(j.title||''),src:String(j.sourceLang||''),co:String(j.company||''),loc:String(j.location||''),
        it:String(j.titleByLocale?.it||'')}); } }
  return map;
};
const A=load(process.env.A), B=load(process.env.B);
let common=0,dTitle=0,dSrc=0,dCo=0,dLoc=0,dIt=0;
for(const [id,a] of A){ const b=B.get(id); if(!b)continue; common++;
  if(a.title!==b.title)dTitle++; if(a.src!==b.src)dSrc++; if(a.co!==b.co)dCo++; if(a.loc!==b.loc)dLoc++; if(a.it!==b.it)dIt++; }
console.log(JSON.stringify({A:A.size,B:B.size,common,dTitle,dSrc,dCo,dLoc,dIt}));
