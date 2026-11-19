import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,mkdirSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it} from 'vitest';
import {ExecGitCommandRunner} from '../../src/git/GitPublishService.ts';

const guard=resolve('runtime/bin/public-repository-guard.mjs');
const denied='restricted-fixture.example';
const dirs=[];
afterEach(()=>{for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(remote='https://github.com/example/project.git'){
  const cwd=mkdtempSync(join(tmpdir(),'public-guard-'));dirs.push(cwd);
  const tool=mkdtempSync(join(tmpdir(),'public-guard-tool-'));dirs.push(tool);
  mkdirSync(join(tool,'runtime','bin'),{recursive:true});mkdirSync(join(tool,'.link-bot'));mkdirSync(join(tool,'.githooks'));
  const script=join(tool,'runtime','bin','public-repository-guard.mjs');copyFileSync(guard,script);
  const hooks=join(tool,'.githooks');
  for(const name of ['pre-commit','commit-msg','pre-push'])copyFileSync(resolve('.githooks',name),join(hooks,name));
  writeFileSync(join(tool,'.link-bot','publication-policy.json'),JSON.stringify({version:2,terms:[denied],
    gitIdentities:[{name:'Public Contributor',email:'public@example.com'}],githubLogins:['public-user']}));
  const env={...process.env,GIT_AUTHOR_NAME:'Public Contributor',GIT_AUTHOR_EMAIL:'public@example.com',
    GIT_COMMITTER_NAME:'Public Contributor',GIT_COMMITTER_EMAIL:'public@example.com'};
  for(const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE'])delete env[k];
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init');git('config','user.name','Public Contributor');git('config','user.email','public@example.com');
  git('remote','add','origin',remote);
  writeFileSync(join(cwd,'README.md'),'Public source\n');git('add','.');git('commit','-m','Initial public source');
  const run=(mode,...args)=>spawnSync(process.execPath,[script,mode,...args],{cwd,env,encoding:'utf8'});
  const ghdir=join(tool,'bin');mkdirSync(ghdir);env.PATH=`${ghdir}:${env.PATH}`;
  const account=(value)=>{
    writeFileSync(join(ghdir,'gh'),`#!/bin/sh\ncase "$1" in\nrepo) printf '%s\\n' '{"url":"https://github.com/example/project.git","defaultBranchRef":{"name":"main"}}';;\n*) printf '%s\\n' '${JSON.stringify(value)}';;\nesac\n`);chmodSync(join(ghdir,'gh'),0o755);
  };
  const prSetup=(profile)=>{
    const bare=join(tool,'remote');git('init','--bare',bare);git('push',bare,'HEAD:refs/heads/main');
    git('config',`url.${bare}.insteadOf`,'https://github.com/example/project.git');account(profile);
  };
  const gh=(args)=>{const r=run('--check-gh',...args);if(r.status!==0)throw Error(r.stderr);};
  return {cwd,env,git,run,guard:script,tool,prSetup,account,gh,write:(path,text)=>writeFileSync(join(cwd,path),text),
    stage:()=>git('add','--all'),head:()=>git('rev-parse','HEAD'),
    install:()=>git('config','core.hooksPath',hooks)};
}

describe('public repository publication guard',()=>{
  it.each(['https://github.com/example/project.git','git@github.com:example/project.git','ssh://git@github.com/example/project.git'])('accepts a clean public snapshot: %s',remote=>{
    const f=fixture(remote);expect(f.run('--index').status).toBe(0);
  });
  it('checks staged blobs rather than clean unstaged replacements',()=>{
    const f=fixture();f.write('README.md',denied);f.stage();f.write('README.md','safe working file');
    expect(f.run('--index').status).not.toBe(0);
  });
  it('allows public product and SDK references without file exemptions',()=>{
    const f=fixture();f.write('README.md','Public Feishu / Lark integration using @larksuite/node-sdk.');f.stage();
    expect(f.run('--index').status).toBe(0);
  });
  it('requires an approved personal identity even without a denied marker',()=>{
    const f=fixture();f.env.GIT_AUTHOR_EMAIL='unknown@example.com';
    expect(f.run('--index').stderr).toContain('unapproved_identity');
  });
  it('rejects newly introduced credentials',()=>{
    const f=fixture();f.write('README.md',['ghp','_'+'x'.repeat(30)].join(''));f.stage();
    expect(f.run('--index').stderr).toContain('credential_material');
  });
  it('does not rescan unchanged legacy files outside this commit',()=>{
    const f=fixture();f.write('old.txt',denied);f.stage();f.git('commit','-m','Old fixture');
    f.write('new.txt','Clean addition');f.stage();expect(f.run('--index').status).toBe(0);
  });
  it('still checks the complete blob when a legacy file is modified',()=>{
    const f=fixture();f.write('README.md',denied);f.stage();f.git('commit','-m','Legacy fixture');
    f.write('README.md',`${denied}\nClean addition`);f.stage();expect(f.run('--index').status).not.toBe(0);
  });
  it.each(['README.md','docs.md','test.mjs','guard.mjs','.gitmodules'])('has no path exemption: %s',path=>{
    const f=fixture();f.write(path,denied.toUpperCase());f.stage();expect(f.run('--index').status).not.toBe(0);
  });
  it('checks tracked path names and normalizes invisible characters',()=>{
    const f=fixture();f.write(`${denied}.txt`,'safe');f.stage();expect(f.run('--index').status).not.toBe(0);
    const other=fixture();other.write('README.md',denied.slice(0,4)+'\u200b'+denied.slice(4));other.stage();
    expect(other.run('--index').status).not.toBe(0);
  });
  it.each(['GIT_AUTHOR_EMAIL','GIT_COMMITTER_EMAIL','GIT_AUTHOR_NAME','GIT_COMMITTER_NAME'])('rejects effective identity from %s',key=>{
    const f=fixture();f.env[key]=key.includes('EMAIL')?`person@${denied}.com`:denied;
    const r=f.run('--index');expect(r.status).not.toBe(0);expect(r.stderr).not.toContain(f.env[key]);
  });
  it('uses actual hooks to reject a commit before HEAD changes',()=>{
    const f=fixture(),before=f.head();f.install();f.write('README.md',denied);f.stage();
    expect(()=>f.git('commit','-m','Safe title')).toThrow();expect(f.head()).toBe(before);
  });
  it('rejects explicit author overrides through a real commit hook',()=>{
    const f=fixture(),before=f.head();f.install();f.write('README.md','safe change');f.stage();
    expect(()=>f.git('commit','--author',`Public User <person@${denied}.com>`,'-m','Safe title')).toThrow();
    expect(f.head()).toBe(before);
  });
  it('rejects commit messages and trailers, not only file contents',()=>{
    const f=fixture(),before=f.head();f.install();f.write('README.md','safe change');f.stage();
    expect(()=>f.git('commit','-m',`Public change\n\nCo-authored-by: User <a@${denied}.com>`)).toThrow();expect(f.head()).toBe(before);
  });
  it('rejects binary data, oversized blobs, submodules, and unmerged entries',()=>{
    const f=fixture();f.write('image.bin',Buffer.from([0,1,2,3]));f.stage();expect(f.run('--index').status).not.toBe(0);
    f.git('reset','--','image.bin');f.write('large.txt','a'.repeat(16*1024*1024+1));f.git('add','large.txt');expect(f.run('--index').status).not.toBe(0);
    f.git('reset','--','large.txt');f.git('update-index','--add','--cacheinfo',`160000,${f.head()},module`);expect(f.run('--index').status).not.toBe(0);
  });
  it('checks an intermediate outgoing commit even when the final snapshot is clean',()=>{
    const f=fixture(),base=f.head();f.write('README.md',denied);f.stage();f.git('commit','-m','Intermediate fixture');
    f.write('README.md','clean again');f.stage();f.git('commit','-m','Clean tip');
    const r=spawnSync(process.execPath,[f.guard,'--push','origin','https://github.com/example/project.git'],{
      cwd:f.cwd,env:f.env,encoding:'utf8',input:`refs/heads/main ${f.head()} refs/heads/main ${base}\n`});
    expect(r.status).not.toBe(0);
  });
  it('checks commit author and committer history, not just current Git config',()=>{
    const f=fixture(),base=f.head();f.write('README.md','clean change');f.stage();
    execFileSync('/usr/bin/git',['commit','-m','Clean change'],{cwd:f.cwd,env:{...f.env,GIT_COMMITTER_EMAIL:`a@${denied}.com`},stdio:'pipe'});
    const r=spawnSync(process.execPath,[f.guard,'--push','origin','https://github.com/example/project.git'],{
      cwd:f.cwd,env:f.env,encoding:'utf8',input:`refs/heads/main ${f.head()} refs/heads/main ${base}\n`});expect(r.status).not.toBe(0);
  });
  it('rejects attempts to skip hooks in the runtime guard',()=>{
    const f=fixture();expect(f.run('--check-git','-c','core.hooksPath=/dev/null','commit','--no-verify','-m','safe').status).not.toBe(0);
  });
  it('checks a task export independently of disabled repository hooks',async()=>{
    const f=fixture(),before=f.head();f.write('README.md',denied);f.stage();
    await expect(new ExecGitCommandRunner().run(f.cwd,['-c','core.hooksPath=/dev/null','commit','-m','safe'])).rejects.toThrow('PUBLIC_REPOSITORY_GUARD');
    expect(f.head()).toBe(before);
  });
  it('rejects an actual push before any branch reaches the destination',()=>{
    const f=fixture(),bare=mkdtempSync(join(tmpdir(),'public-guard-remote-'));dirs.push(bare);
    f.git('init','--bare',bare);
    f.git('config',`url.${bare}.insteadOf`,'https://github.com/example/project.git');
    f.write('README.md',denied);f.stage();f.git('commit','-m','Fixture');f.install();
    expect(()=>f.git('push','origin','HEAD:refs/heads/main')).toThrow();
    expect(execFileSync('/usr/bin/git',['--git-dir',bare,'for-each-ref','--format=%(refname)'],{encoding:'utf8'}).trim()).toBe('');
  });
  it('does not scan unrelated local branches in push preflight',()=>{
    const f=fixture();f.git('branch','other');f.git('checkout','other');f.write('README.md',denied);f.stage();f.git('commit','-m','Unrelated');
    f.git('checkout','-');expect(f.run('--check-git','push','origin','HEAD:refs/heads/main').status).toBe(0);
  });
  it('does not apply GitHub policy to an explicitly private push destination',()=>{
    const f=fixture();f.write('README.md',denied);f.stage();f.git('commit','-m','Private fixture');
    f.git('remote','add','private','ssh://source.example/team/repo.git');
    expect(f.run('--check-git','push','private','HEAD').status).toBe(0);
    expect(f.run('--check-git','push','--repo=ssh://source.example/team/repo.git','HEAD').status).toBe(0);
    expect(f.run('--check-git','push','origin','--no-verify').stderr).toContain('hook_bypass_forbidden');
  });
  it('does not apply commit policy solely because of an unrelated public remote',()=>{
    const f=fixture('ssh://source.example/team/repo.git');f.git('remote','add','public','https://github.com/example/project.git');
    f.write('README.md',denied);f.stage();expect(f.run('--index').status).toBe(0);
    expect(f.run('--check-git','push','public','--no-verify').stderr).toContain('hook_bypass_forbidden');
  });
  it('recognizes direct URL aliases without network access',()=>{
    const f=fixture('ssh://source.example/team/repo.git');f.git('config','url.https://github.com/.insteadOf','public-alias:');
    expect(f.run('--check-git','push','public-alias:example/project.git','--no-verify').stderr).toContain('hook_bypass_forbidden');
  });
  it('checks the exact outgoing range using a real forced pre-push hook',()=>{
    const f=fixture();f.prSetup({login:'public-user'});f.git('branch','other');f.git('checkout','other');
    f.write('README.md',denied);f.stage();f.git('commit','-m','Unrelated local work');f.git('checkout','-');
    f.write('README.md','Clean outgoing work');f.stage();f.git('commit','-m','Public change');
    expect(f.run('--run-git','push','origin','HEAD:refs/heads/main').status).toBe(0);
    f.write('README.md',denied);f.stage();f.git('commit','-m','Restricted fixture');
    const r=f.run('--run-git','-c','core.hooksPath=/dev/null','push','origin','HEAD:refs/heads/main');
    expect(r.status).not.toBe(0);expect(r.stderr).toContain('restricted_marker');
  });
  it('excludes already-advertised public history for a new branch',()=>{
    const f=fixture();f.write('legacy.txt',denied);f.stage();f.git('commit','-m','Previously public fixture');
    f.prSetup({login:'public-user'});f.write('README.md','New clean change');f.stage();f.git('commit','-m','Public change');
    expect(f.run('--run-git','push','origin','HEAD:refs/heads/new').status).toBe(0);
  });
  it('checks new changes against the live PR base, not already-public history',()=>{
    const f=fixture();f.write('legacy.txt',denied);f.stage();f.git('commit','-m','Previously public fixture');f.prSetup({login:'public-user'});
    f.write('README.md','New public change');f.stage();f.git('commit','-m','Public change');
    expect(()=>f.gh(['pr','create','--title','Public change','--body','Public explanation'])).not.toThrow();
    f.write('README.md',denied);f.stage();f.git('commit','-m','Restricted change');
    expect(()=>f.gh(['pr','create','--title','Public change','--body','Public explanation'])).toThrow('restricted_marker');
  });
  it('allows unrelated API writes and explicit GET requests',()=>{
    const f=fixture();expect(()=>f.gh(['api','repos/example/project/actions/workflows/build/dispatches','-XPOST'])).not.toThrow();
    expect(()=>f.gh(['api','repos/example/project/pulls','-XGET','-f','state=open'])).not.toThrow();
  });
  it('rejects an unapproved GitHub login even for clean PR text',()=>{
    const f=fixture();f.prSetup({login:'other-user'});
    expect(()=>f.gh(['pr','create','--title','Public change','--body','Public explanation'])).toThrow('unapproved_github_account');
  });
  it('accepts a verified clean account and rejects malformed account evidence',()=>{
    const f=fixture();f.prSetup({login:'public-user',company:denied,bio:denied,email:`a@${denied}`});
    expect(()=>f.gh(['pr','create','--title','Public change','--body','Public explanation'])).not.toThrow();
    f.account({message:'no identity'});
    expect(()=>f.gh(['pr','create','--title','Public change','--body','Public explanation'])).toThrow('unverified_github_account');
  });
  it('does not replace existing custom hooks during installation',()=>{
    const f=fixture();f.git('config','core.hooksPath','custom-hooks');
    const r=spawnSync(process.execPath,[resolve('scripts/install-public-repository-hooks.mjs'),'--repo',f.cwd],{encoding:'utf8'});
    expect(r.status).not.toBe(0);expect(f.git('config','--local','--get','core.hooksPath')).toBe('custom-hooks');
  });
  it('rejects uninspected external file objects',()=>{
    const f=fixture();f.write('asset','version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 100\n');f.stage();
    expect(f.run('--index').status).not.toBe(0);
  });
  it('fails closed on conflicted index stages',()=>{
    const f=fixture(),blob=f.git('rev-parse','HEAD:README.md');f.git('update-index','--force-remove','README.md');
    execFileSync('/usr/bin/git',['update-index','--index-info'],{cwd:f.cwd,env:f.env,
      input:`100644 ${blob} 1\tREADME.md\n100644 ${blob} 2\tREADME.md\n100644 ${blob} 3\tREADME.md\n`});
    expect(f.run('--index').stderr).toContain('unmerged_index');
  });
  it('refuses short and inline API-write flag variants',()=>{
    const f=fixture();for(const args of [
      ['api','repos/example/project/pulls','-XPOST'],
      ['api','repos/example/project/pulls','--raw-field=title=value'],
      ['api','repos/example/project/pulls','-ftitle=value'],
      ['api','-X','POST','repos/example/project/pulls'],
    ])expect(()=>f.gh(args)).toThrow('use_guarded_publication_command');
  });
  it('refuses an invalid private policy instead of silently allowing publication',()=>{
    const f=fixture(),isolated=join(f.cwd,'isolated');mkdirSync(join(isolated,'runtime','bin'),{recursive:true});
    mkdirSync(join(isolated,'.link-bot'));copyFileSync(guard,join(isolated,'runtime','bin','guard.mjs'));
    writeFileSync(join(isolated,'.link-bot','publication-policy.json'),'{}');
    const r=spawnSync(process.execPath,[join(isolated,'runtime','bin','guard.mjs'),'--index'],{cwd:f.cwd,env:f.env,encoding:'utf8'});
    expect(r.status).not.toBe(0);expect(r.stderr).toContain('policy_missing_or_invalid');
  });
  it('refuses automatic commit paths and permits explicit staging-only requests',()=>{
    const f=fixture();expect(f.run('--check-git','cherry-pick','HEAD').stderr).toContain('unsupported_automatic_commit_path');
    expect(f.run('--check-git','cherry-pick','--no-commit','HEAD').status).toBe(0);
  });
  it('leaves a repository with no public remote outside this policy',()=>{
    const f=fixture('/tmp/private-repository');f.write('README.md',denied);f.stage();expect(f.run('--index').status).toBe(0);
  });
  it('recognizes a public push URL on an otherwise private origin',()=>{
    const f=fixture('/tmp/private-repository');f.git('remote','set-url','--push','origin','https://github.com/example/project.git');
    f.write('README.md',denied);f.stage();expect(f.run('--index').status).not.toBe(0);
  });
  it('blocks PR text, file payloads and API-write bypasses before invoking the CLI',()=>{
    const f=fixture();expect(()=>f.gh(['pr','create','--title',denied,'--body','safe'])).toThrow('restricted_marker');
    f.write('body.md',denied);expect(()=>f.gh(['pr','create','--title','safe','--body-file','body.md'])).toThrow('restricted_marker');
    expect(()=>f.gh(['pr','create','--web'])).toThrow('uninspected_pr_editor');
    expect(()=>f.gh(['api','repos/example/project/pulls','-f','title=safe'])).toThrow('use_guarded_publication_command');
  });
  it('wires independent checks into runtime wrappers and image hooks',()=>{
    const dockerfile=readFileSync('runtime/Dockerfile','utf8');
    expect(dockerfile).toContain('core.hooksPath /opt/link-bot/guard/.githooks');
    expect(readFileSync('runtime/bin/git-wrapper','utf8')).toContain('--run-git');
    expect(readFileSync('runtime/bin/gh-wrapper','utf8')).toContain('--run-gh');
    expect(readFileSync('src/git/DockerTaskPublishBroker.ts','utf8')).not.toContain('core.hooksPath=/dev/null');
  });
});
