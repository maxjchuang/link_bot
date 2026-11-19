import {execFileSync,spawnSync} from 'node:child_process';
import {chmodSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=resolve(root,'.githooks');
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--repo'))throw Error('Usage: install-public-repository-hooks.mjs [--repo <path>]');
const repository=args.length?resolve(args[1]):root;
const result=spawnSync('/usr/bin/git',['config','--local','--get','core.hooksPath'],{cwd:repository,encoding:'utf8'});
if(result.status!==0&&result.status!==1)throw Error('Cannot inspect hooks configuration.');
const current=result.stdout.trim();
if(current&&resolve(repository,current)!==target)throw Error('Existing hooksPath is configured; refusing to overwrite it.');
const legacy=execFileSync('/usr/bin/git',['rev-parse','--git-path','hooks'],{cwd:repository,encoding:'utf8'}).trim();
if(!current&&['pre-commit','commit-msg','pre-push'].some(name=>existsSync(resolve(repository,legacy,name)))){
  throw Error('Existing hooks found; refusing to silently replace them.');
}
for(const name of ['pre-commit','commit-msg','pre-push'])chmodSync(resolve(target,name),0o755);
execFileSync('/usr/bin/git',['config','--local','core.hooksPath',target],{cwd:repository});
console.log('Public repository hooks installed: pre-commit, commit-msg, pre-push.');
