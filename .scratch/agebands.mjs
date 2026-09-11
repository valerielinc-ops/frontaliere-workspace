import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo='/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no';
const src=process.env.SRC, ref=process.env.REF;
const rel=await import(pathToFileURL(path.join(src,'scripts/relocalize-pending-jobs.mjs')).href);
const pri=await import(pathToFileURL(path.join(src,'scripts/lib/job-traffic-priority.mjs')).href);
const isIncomplete=rel.isIncomplete;
const queuedAt=pri.jobQueuedAtMs;
const now=Date.now();
const D=24*3600*1000;
const bands={'<24h':[0,D],'24-48h':[D,2*D],'2-7g':[2*D,7*D],'7-30g':[7*D,30*D],'>30g':[30*D,Infinity],'senza data':null};
const acc={}; for(const k of Object.keys(bands)) acc[k]={tot:0,inc:0};
const tree=execFileSync('git',['ls-tree',ref,'data/jobs/by-crawler/'],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});
for(const line of tree.trimEnd().split('\n').filter(Boolean)){
  const[m]=line.split('\t'); const[,t,sha]=m.split(/\s+/); if(t!=='blob')continue;
  let raw;try{raw=execFileSync('git',['cat-file','blob',sha],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});}catch{continue;}
  let d;try{d=JSON.parse(raw);}catch{continue;}
  if(!d||Array.isArray(d)||!Array.isArray(d.jobs))continue;
  for(const j of d.jobs){ if(!j||typeof j!=='object')continue;
    const q=queuedAt(j); const age=Number.isFinite(q)?now-q:null;
    let key='senza data';
    if(age!==null){ for(const[k,r] of Object.entries(bands)){ if(!r)continue; if(age>=r[0]&&age<r[1]){key=k;break;} } }
    acc[key].tot++; if(isIncomplete(j)) acc[key].inc++; }
}
const rows=Object.entries(acc).map(([k,v])=>[k,v.tot,v.inc,v.tot?((100*(v.tot-v.inc)/v.tot).toFixed(1)+'%'):'-'].join('\t'));
console.log('fascia\tjob\tincomplete\tcomplete%');
console.log(rows.join('\n'));
const T=Object.values(acc).reduce((a,v)=>({tot:a.tot+v.tot,inc:a.inc+v.inc}),{tot:0,inc:0});
console.log(['TOTALE',T.tot,T.inc,(100*(T.tot-T.inc)/T.tot).toFixed(1)+'%'].join('\t'));
