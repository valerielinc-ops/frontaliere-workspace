import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const repo='/Users/saggesel/Projects/frontaliere/frontaliere-si-o-no';
const src=process.env.SRC, ref=process.env.REF;
const mod=await import(pathToFileURL(path.join(src,'scripts/relocalize-pending-jobs.mjs')).href);
const isIncomplete=mod.isIncomplete;
if(typeof isIncomplete!=='function'){console.error('isIncomplete non esportata');process.exit(1);}
const tree=execFileSync('git',['ls-tree',ref,'data/jobs/by-crawler/'],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});
const entries=tree.trimEnd().split('\n').filter(Boolean).map(l=>{const[m]=l.split('\t');const[,t,sha]=m.split(/\s+/);return{t,sha};}).filter(e=>e.t==='blob');
let jobs=0,inc=0;
for(const e of entries){let raw;try{raw=execFileSync('git',['cat-file','blob',e.sha],{cwd:repo,encoding:'utf8',maxBuffer:1<<28});}catch{continue;}
 let d;try{d=JSON.parse(raw);}catch{continue;}
 if(!d||Array.isArray(d)||!Array.isArray(d.jobs))continue;
 for(const j of d.jobs){if(!j||typeof j!=='object')continue;jobs++;if(isIncomplete(j))inc++;}}
console.log([ref.slice(0,11),jobs,inc,(100*(jobs-inc)/jobs).toFixed(2)+'%'].join('\t'));
