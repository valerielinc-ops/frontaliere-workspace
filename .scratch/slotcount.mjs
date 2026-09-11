import { execFileSync } from 'node:child_process';
const repo='/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no';
const ref=process.env.REF;
const tree=execFileSync('git',['ls-tree',ref,'data/jobs/by-crawler/'],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});
const entries=tree.trimEnd().split('\n').filter(Boolean).map(l=>{const[m,n]=l.split('\t');const[,t,sha]=m.split(/\s+/);return{t,sha,n};}).filter(e=>e.t==='blob');
let jobs=0, it=0, en=0, fr=0, de=0, allFour=0;
for(const e of entries){
  let raw; try{ raw=execFileSync('git',['cat-file','blob',e.sha],{cwd:repo,encoding:'utf8',maxBuffer:1<<28}); }catch{ continue; }
  let d; try{ d=JSON.parse(raw); }catch{ continue; }
  if(!d||Array.isArray(d)||!Array.isArray(d.jobs)) continue;
  for(const j of d.jobs){ if(!j||typeof j!=='object') continue; jobs++;
    const t=j.titleByLocale||{};
    const has=l=>String(t[l]||'').trim().length>0;
    if(has('it'))it++; if(has('en'))en++; if(has('fr'))fr++; if(has('de'))de++;
    if(has('it')&&has('en')&&has('fr')&&has('de'))allFour++; }
}
console.log([ref.slice(0,11),jobs,it,en,fr,de,allFour].join('\t'));
