import { execFileSync } from 'node:child_process';
const repo='/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no';
const ref=process.env.REF;
const tree=execFileSync('git',['ls-tree',ref,'data/jobs/by-crawler/'],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});
const entries=tree.trimEnd().split('\n').filter(Boolean).map(l=>{const[m,n]=l.split('\t');const[,t,sha]=m.split(/\s+/);return{t,sha,n};}).filter(e=>e.t==='blob');
let jobs=0, d4=0, shortAny=0, srcShrunk=0;
for(const e of entries){
  let raw; try{ raw=execFileSync('git',['cat-file','blob',e.sha],{cwd:repo,encoding:'utf8',maxBuffer:1<<28}); }catch{ continue; }
  let d; try{ d=JSON.parse(raw); }catch{ continue; }
  if(!d||Array.isArray(d)||!Array.isArray(d.jobs)) continue;
  for(const j of d.jobs){ if(!j||typeof j!=='object') continue; jobs++;
    const db=j.descriptionByLocale||{};
    const len=l=>String(db[l]||'').trim().length;
    const ok=['it','en','fr','de'].every(l=>len(l)>=120);
    if(ok)d4++; else shortAny++;
    const base=String(j.description||'').trim();
    const src=len(j.sourceLang||'it');
    if(base.length>=120 && src>0 && src/Math.max(1,base.length)<0.55) srcShrunk++;
  }
}
console.log([ref.slice(0,11),jobs,d4,shortAny,srcShrunk].join('\t'));
