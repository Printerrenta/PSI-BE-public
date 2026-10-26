import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=new URL('../',import.meta.url);
const services=JSON.parse(readFileSync(new URL('../services.json',import.meta.url),'utf8'));
function git(args,cwd){const r=spawnSync('git',args,{cwd,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();}
for(const [name,s] of Object.entries(services)){
 if(!s.directory)continue;
 const path=resolve(root.pathname.replace(/^\/(?=[A-Z]:)/,''),s.directory);
 if(existsSync(path)){
  if(git(['remote','get-url','origin'],path)!==s.repository)throw new Error('Unexpected checkout '+path);
  console.log('Existing checkout retained: '+path);continue;
 }
 git(['clone',s.repository,path]);
 git(['checkout','--detach',s.commit],path);
 console.log('Cloned release '+name+' at '+s.commit);
}
