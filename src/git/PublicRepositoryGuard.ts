import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

function guardPath():string{
  const source=fileURLToPath(new URL('../../runtime/bin/public-repository-guard.mjs',import.meta.url));
  const built=fileURLToPath(new URL('../../../runtime/bin/public-repository-guard.mjs',import.meta.url));
  return existsSync(source)?source:built;
}

export function publicGitExecution(args:string[]):{command:string;args:string[]}{
  return args.some(value=>['commit','push','merge','cherry-pick','revert','rebase','am'].includes(value))
    ? {command:process.execPath,args:[guardPath(),'--run-git',...args]}
    : {command:'git',args};
}

/** Independent of repository hooks, including exported task repositories. */
export async function requirePublicRepositoryCheck(cwd:string,kind:'git'|'gh',args:string[]):Promise<void>{
  const mutation=kind==='git'
    ? args.some(value=>['commit','push','merge','cherry-pick','revert','rebase','am'].includes(value))
    : args.includes('pr')&&args.some(value=>['create','edit'].includes(value));
  if(!mutation)return;
  const script=guardPath();
  await new Promise<void>((resolve,reject)=>{
    execFile(process.execPath,[script,kind==='git'?'--check-git':'--check-gh',...args],
      {cwd,timeout:120_000,maxBuffer:2_000_000},(error,_out,stderr)=>{
        if(error){
          const detail=stderr.split('\n').find(line=>line.startsWith('PUBLIC_REPOSITORY_GUARD['));
          reject(new Error(detail??'PUBLIC_REPOSITORY_GUARD[inspection_failed]'));return;
        }
        resolve();
      });
  });
}
