import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {describe,expect,it} from 'vitest';
import {SandboxSupervisorClient} from '../../src/runtime/SandboxSupervisorClient.ts';

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'generic-project-')),home=join(root,'home'),workspace=join(root,'workspace'),bridge=join(root,'bridge');
  for(const p of [home,workspace,bridge])mkdirSync(p);
  const remote=join(root,'remote');mkdirSync(remote);
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:remote,encoding:'utf8',stdio:'pipe'}).trim();
  git('init');git('symbolic-ref','HEAD','refs/heads/main');writeFileSync(join(remote,'README.md'),'original\n');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','Fixture');
  const global=join(home,'.gitconfig');
  writeFileSync(global,`[url "${remote}"]\n insteadOf = https://source.example/team/repo.git\n`);
  const child=spawn(process.execPath,[resolve('runtime/bin/link-bot-sandbox-supervisor.mjs')],{env:{...process.env,
    HOME:home,CODEX_HOME:join(home,'.codex'),GIT_CONFIG_GLOBAL:global,LINK_BOT_ALLOW_UNPRIVILEGED_TEST:'1',
    LINK_BOT_AUTH_FILE:'',LINK_BOT_TOOL_HOME:join(home,'tool-home'),LINK_BOT_NATIVE_GIT_HOME:join(home,'native-git'),
    LINK_BOT_DEFAULT_AGENTS_FILE:resolve('runtime/defaults/AGENTS.md'),
    LINK_BOT_WORKSPACE_ROOT:workspace,LINK_BOT_BRIDGE_ROOT:bridge,LINK_BOT_TASK_TMP_ROOT:join(root,'tmp'),
    LINK_BOT_TASK_UID:String(process.getuid()),LINK_BOT_TASK_GID:String(process.getgid()),
    LINK_BOT_HOST_UID:String(process.getuid()),LINK_BOT_HOST_GID:String(process.getgid())},stdio:['ignore','pipe','pipe']});
  child.stdout.resume();let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000);});
  const socket=join(bridge,'supervisor.sock');
  for(let i=0;i<200&&!existsSync(socket);i++){if(child.exitCode!==null)throw Error(`Test supervisor exited: ${errors}`);await new Promise(r=>setTimeout(r,10));}
  const client=new SandboxSupervisorClient(socket,5000);
  return {root,workspace,global,client,git,close:async()=>{
    const exit=once(child,'exit');child.kill('SIGTERM');await exit;rmSync(root,{recursive:true,force:true});
  }};
}
describe('generic configured repository bootstrap',()=>{
  it('clones a configured endpoint and preserves dirty files when rejecting a different origin',async()=>{
    const f=await fixture();try{
      const request={projectId:'repo',cloneUrl:'https://source.example/team/repo.git',baseRef:'main'};
      expect(await f.client.ensureProject(request)).toMatchObject({status:'ready'});
      writeFileSync(f.global,'');const file=join(f.workspace,'repo','README.md');writeFileSync(file,'uncommitted work\n');
      expect(await f.client.ensureProject(request)).toMatchObject({status:'ready'});
      await expect(f.client.ensureProject({...request,cloneUrl:'https://other.example/team/repo.git'})).rejects.toThrow('project_origin_mismatch');
      expect(readFileSync(file,'utf8')).toBe('uncommitted work\n');
    }finally{await f.close();}
  });
  it('reports a missing branch without asking for repository authorization',async()=>{
    const f=await fixture();try{
      await expect(f.client.ensureProject({projectId:'missing',cloneUrl:'https://source.example/team/repo.git',baseRef:'missing-branch'})).rejects.toThrow('project_branch_missing');
    }finally{await f.close();}
  });
});
