#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {TextDecoder} from 'node:util';

const maxBytes=16*1024*1024,decoder=new TextDecoder('utf-8',{fatal:true});
const gitBinary='/usr/bin/git';
const env={...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'};
const here=dirname(fileURLToPath(import.meta.url));
const hooksPath=resolve(here,'../../.githooks');
function fail(code,where=''){throw new Error(`PUBLIC_REPOSITORY_GUARD[${code}]${where?` ${JSON.stringify(where)}`:''}`);}
function command(binary,args,cwd=process.cwd()){
  const r=spawnSync(binary,args,{cwd,env,encoding:null,maxBuffer:64*1024*1024});
  if(r.error||r.status!==0)fail('inspection_failed');return r.stdout;
}
function git(args,context={}){return command(gitBinary,[...(context.globals??[]),...args],context.cwd).toString('utf8').trim();}
function normalized(text){return text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').toLowerCase();}
let cachedPolicy;
function policy(){
  if(cachedPolicy)return cachedPolicy;
  // Policy is private deployment data, never a public source-code exception.
  const local=resolve(here,'../../.link-bot/publication-policy.json');
  const path=existsSync(local)?local:'/run/link-bot/secrets/publication-policy.json';
  let value;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{fail('policy_missing_or_invalid');}
  if(value.version!==2||!Array.isArray(value.terms)||!value.terms.length
    ||value.terms.some(t=>typeof t!=='string'||!t.trim())
    ||!Array.isArray(value.gitIdentities)||!value.gitIdentities.length
    ||value.gitIdentities.some(i=>typeof i.name!=='string'||!i.name.trim()||typeof i.email!=='string'||!i.email.includes('@'))
    ||!Array.isArray(value.githubLogins)||!value.githubLogins.length
    ||value.githubLogins.some(l=>typeof l!=='string'||!/^[a-z0-9-]+$/i.test(l)))fail('policy_missing_or_invalid');
  cachedPolicy={...value,terms:value.terms.map(t=>normalized(t))};return cachedPolicy;
}
export function checkText(text,where){
  const terms=policy().terms;
  const n=normalized(text);
  const rule=terms.findIndex(t=>n.includes(t));
  if(rule>=0)fail(`restricted_marker_${rule+1}`,where);
  if(/(?:ou_|on_|cli_)[a-f0-9]{20,}/i.test(n)||/\/data\d+\/home\//i.test(n))fail('internal_identifier',where);
  if(/(?:gh[pousr]_|github_pat_)[a-z0-9_]{20,}/i.test(text)
    ||/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)
    ||/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(text))fail('credential_material',where);
}
function checkBuffer(bytes,where){
  if(bytes.length>maxBytes)fail('unscannable_size',where);
  let text;try{text=decoder.decode(bytes);}catch{fail('unscannable_encoding',where);}
  if(text.includes('\0'))fail('unscannable_binary',where);
  if(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text))fail('unscannable_external_object',where);
  checkText(text,where);
}
function isGithub(url){
  if(/^(?:https?|ssh|git):\/\/(?:[^/@]+@)?(?:github\.com|ssh\.github\.com)(?::\d+)?\//i.test(url)
    ||/^[^@\s]+@(?:github\.com|ssh\.github\.com):/i.test(url))return true;
  return false;
}
function remoteUrls(remote,context={},push=false){
  if(!git(['remote'],context).split('\n').includes(remote))return [remote,git(['ls-remote','--get-url','--',remote],context)];
  const urls=[];
  const key=push&&optionalGit(['config','--get',`remote.${remote}.pushurl`],context)?'pushurl':'url';
  urls.push(...git(['config','--get-all',`remote.${remote}.${key}`],context).split('\n'));
  urls.push(...git(['remote','get-url',...(push?['--push']:[]),'--all',remote],context).split('\n'));
  return urls;
}
function optionalGit(args,context={}){
  const r=spawnSync(gitBinary,[...(context.globals??[]),...args],{cwd:context.cwd,env,encoding:'utf8'});
  if(r.status===1)return undefined;if(r.error||r.status!==0)fail('inspection_failed');return r.stdout.trim();
}
function protectedRepository(context={},target){
  if(target!==undefined)return remoteUrls(target,context,true).some(isGithub);
  return [...remoteUrls('origin',context),...remoteUrls('origin',context,true)].some(isGithub);
}
function checkIdentity(ident,where){
  checkText(ident,where);
  const match=/^([^<>\r\n]+) <([^<>\s]+@[^<>\s]+)>(?: \d+ [+-]\d{4})?$/.exec(ident);
  if(!match)fail('invalid_identity',where);
  if(!policy().gitIdentities.some(i=>i.name===match[1]&&i.email.toLowerCase()===match[2].toLowerCase()))fail('unapproved_identity',where);
}
function checkIdentities(context={},author){
  for(const kind of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT']){
    checkIdentity(git(['var',kind],context),kind);
  }
  if(author)checkIdentity(author,'explicit author');
}
function scanner(context={}){
  const seen=new Set();
  const blob=(oid,where)=>{
    if(seen.has(oid))return;
    if(Number(git(['cat-file','-s',oid],context))>maxBytes)fail('unscannable_size',where);
    const bytes=command(gitBinary,[...(context.globals??[]),'cat-file','blob',oid],context.cwd);
    checkBuffer(bytes,where);seen.add(oid);
  };
  const tree=(revision)=>{
    // Inspect what this publication adds/changes, not unrelated legacy files.
    const parent=revision?git(['rev-list','--parents','-n','1',revision],context).split(' ')[1]:undefined;
    const changed=new Set(command(gitBinary,[...(context.globals??[]),...(revision
      ?['diff-tree','--root','--no-commit-id','--name-only','--diff-filter=ACMRT','-r','-z',...(parent?[parent]:[]),revision]
      :['diff','--cached','--name-only','--diff-filter=ACMRT','-z'])],context.cwd).toString('utf8').split('\0').filter(Boolean));
    const bytes=command(gitBinary,[...(context.globals??[]),...(revision?['ls-tree','-rz','--full-tree',revision]:['ls-files','--stage','-z'])],context.cwd);
    for(const row of bytes.toString('utf8').split('\0').filter(Boolean)){
      const tab=row.indexOf('\t');if(tab<0)fail('invalid_tree_entry');
      const header=row.slice(0,tab).split(' '),path=row.slice(tab+1);
      if(!revision&&header[2]!=='0')fail('unmerged_index',path);
      if(!changed.has(path))continue;
      checkText(path,'tracked path');
      if(header[0]==='160000')fail('unscannable_submodule',path);
      blob(revision?header[2]:header[1],path);
    }
  };
  const commit=(oid)=>{
    const metadata=command(gitBinary,[...(context.globals??[]),'cat-file','commit',oid],context.cwd);
    checkBuffer(metadata,`commit ${oid}`);
    const header=metadata.toString('utf8').split('\n\n')[0];
    for(const kind of ['author','committer']){
      const line=header.split('\n').find(l=>l.startsWith(`${kind} `));if(!line)fail('invalid_identity');
      checkIdentity(line.slice(kind.length+1),`commit ${oid} ${kind}`);
    }
    tree(oid);
  };
  return {tree,commit};
}
export function checkIndex(context={},author){
  if(!protectedRepository(context))return;
  checkIdentities(context,author);scanner(context).tree();
}
function peel(oid,context){
  let current=oid;
  for(let depth=0;depth<32;depth++){
    const type=git(['cat-file','-t',current],context);
    if(type==='commit')return current;
    if(type!=='tag')fail('non_commit_push');
    const bytes=command(gitBinary,[...(context.globals??[]),'cat-file','tag',current],context.cwd);
    checkBuffer(bytes,'tag metadata');
    const next=/^object ([a-f0-9]{40,64})$/m.exec(bytes.toString('utf8'))?.[1];
    if(!next)fail('invalid_tag');current=next;
  }
  fail('unscannable_tag_depth');
}
function checkRange(head,base,context={},scan=scanner(context)){
  const tip=peel(head,context);
  const args=['rev-list',tip];if(base&&!/^0+$/.test(base))args.push(`^${peel(base,context)}`);
  const commits=git(args,context).split('\n').filter(Boolean);
  for(const oid of commits)scan.commit(oid);
}
export function checkPush(input,context={},target,remote){
  if(!protectedRepository(context,target)&&!(remote&&protectedRepository(context,remote)))return;
  const scan=scanner(context);
  for(const line of input.split('\n').filter(Boolean)){
    const fields=line.trim().split(/\s+/);if(fields.length!==4)fail('invalid_push_input');
    const [localRef,head,remoteRef,base]=fields;checkText(localRef,'local ref');checkText(remoteRef,'remote ref');
    if(/^0+$/.test(head))continue;
    if(!/^[a-f0-9]{40,64}$/.test(head)||!/^[a-f0-9]{40,64}$/.test(base))fail('invalid_push_oid');
    // A new branch may reuse already-published history. Only trust refs advertised
    // by this destination now, never unrelated or stale local tracking refs.
    if(/^0+$/.test(base)){
      const existing=git(['ls-remote','--heads','--',target??remote],context).split('\n').filter(Boolean).map(l=>l.split(/\s+/)[0]);
      const exclusions=[];
      for(const oid of new Set(existing)){
        if(!/^[a-f0-9]{40,64}$/.test(oid))fail('invalid_remote_oid');
        if(optionalGit(['cat-file','-e',`${oid}^{commit}`],context)!==undefined)exclusions.push(`^${oid}`);
      }
      const tip=peel(head,context);
      for(const oid of git(['rev-list',tip,...exclusions],context).split('\n').filter(Boolean))scan.commit(oid);
    }else checkRange(head,base,context,scan);
  }
}
function splitGit(args){
  const globals=[];let i=0;
  for(;i<args.length;i++){
    const a=args[i];if(!a.startsWith('-'))break;
    globals.push(a);
    if(['-C','-c','--git-dir','--work-tree','--namespace','--super-prefix','--config-env'].includes(a)){
      if(args[++i]===undefined)fail('invalid_git_arguments');globals.push(args[i]);
    }
  }
  return {globals,name:args[i],args:args.slice(i+1)};
}
function option(args,name,short){
  const index=args.findIndex(a=>a===name||a===short);if(index>=0)return args[index+1];
  const inline=args.find(a=>a.startsWith(name+'='));return inline?.slice(name.length+1);
}
function pushTarget(args,context){
  const explicit=option(args,'--repo');if(explicit)return explicit;
  const values=new Set(['--receive-pack','--exec','--push-option','-o']);
  for(let i=0;i<args.length;i++){
    if(values.has(args[i])){i++;continue;}
    if(args[i]==='--')return args[i+1]??'origin';
    if(!args[i].startsWith('-'))return args[i];
  }
  const branch=optionalGit(['symbolic-ref','--quiet','--short','HEAD'],context);
  return (branch&&optionalGit(['config','--get',`branch.${branch}.pushRemote`],context))
    ??optionalGit(['config','--get','remote.pushDefault'],context)
    ??(branch&&optionalGit(['config','--get',`branch.${branch}.remote`],context))??'origin';
}
export function checkGit(args,cwd=process.cwd()){
  const parsed=splitGit(args),context={cwd,globals:parsed.globals};
  if(!['commit','push','merge','cherry-pick','revert','rebase','am'].includes(parsed.name))return false;
  const target=parsed.name==='push'?pushTarget(parsed.args,context):undefined;
  if(!protectedRepository(context,target))return false;
  if(!['commit','push'].includes(parsed.name)
    && !parsed.args.some(a=>['--abort','--quit','--no-commit','--squash'].includes(a)))fail('unsupported_automatic_commit_path');
  if(parsed.args.some(a=>a==='--no-verify'||a==='-n'&&parsed.name!=='push'))fail('hook_bypass_forbidden');
  if(parsed.name==='commit'){
    checkIndex(context,option(parsed.args,'--author'));
    for(let i=0;i<parsed.args.length;i++){
      const a=parsed.args[i];
      if(a==='-m'||a==='--message')checkText(parsed.args[++i]??'','commit message');
      else if(a.startsWith('--message='))checkText(a.slice(10),'commit message');
      else if(a==='-F'||a==='--file'){
        const f=parsed.args[++i];if(!f||f==='-')fail('explicit_message_file_required');checkBuffer(readFileSync(resolve(cwd,f)),'commit message');
      }
    }
  }
  // The forced pre-push hook receives the exact selected ref updates from Git.
  return true;
}
export function checkGh(args,cwd=process.cwd(),realGh='/usr/local/libexec/gh'){
  // Block alternate publication APIs, not unrelated API operations.
  const method=option(args,'--method','-X')??args.find(a=>/^-X.+/.test(a))?.slice(2);
  const api=args.indexOf('api');
  const apiValueOptions=new Set(['--method','-X','--hostname','--field','--raw-field','-f','-F','--input','--header','-H','--cache','--jq','-q','--template','-t','--preview','-p']);
  let endpoint='';
  for(let i=api+1;api>=0&&i<args.length;i++){
    if(apiValueOptions.has(args[i])){i++;continue;}
    if(!args[i].startsWith('-')){endpoint=args[i];break;}
  }
  const apiWrite=(method&&method.toUpperCase()!=='GET')
    ||(!method&&args.some(a=>/^(?:-[fF](?:.|$)|--(?:raw-field|field|input)(?:=|$))/.test(a)));
  if(api>=0&&apiWrite&&(/(?:^|\/)(?:pulls|issues|comments|contents|git|releases|gists)(?:\/|$)/.test(endpoint)
    ||endpoint==='graphql'))fail('use_guarded_publication_command');
  const pos=args.indexOf('pr');if(pos<0||!['create','edit'].includes(args[pos+1]))return;
  if(args.some(a=>['--web','--editor','-w','-e','--recover'].includes(a)))fail('uninspected_pr_editor');
  for(const flag of ['--title','--body']){
    const v=option(args,flag,flag==='--title'?'-t':'-b');if(v!==undefined)checkText(v,`PR ${flag.slice(2)}`);
  }
  const file=option(args,'--body-file','-F');if(file){if(file==='-')fail('explicit_body_file_required');checkBuffer(readFileSync(resolve(cwd,file)),'PR body');}
  if(args[pos+1]==='create'&&(option(args,'--title','-t')===undefined
    ||option(args,'--body','-b')===undefined&&!file))fail('explicit_pr_title_body_required');
  const context={cwd},repository=option(args,'--repo','-R');
  const selection=repository?['--repo',repository]:[];
  let head=option(args,'--head','-H')??'HEAD',base;
  if(args[pos+1]==='edit'){
    const selector=args[pos+2]&&!args[pos+2].startsWith('-')?[args[pos+2]]:[];
    const current=JSON.parse(command(realGh,['pr','view',...selector,...selection,'--json','headRefOid,baseRefOid,headRefName,title,body,url'],cwd).toString('utf8'));
    if(!isGithub(current.url??'')||!/^[a-f0-9]{40,64}$/.test(current.headRefOid??'')||!/^[a-f0-9]{40,64}$/.test(current.baseRefOid??''))fail('unverified_pr_head');
    head=current.headRefOid;base=current.baseRefOid;
    checkText(option(args,'--title','-t')??current.title??'','PR title');
    if(!file)checkText(option(args,'--body','-b')??current.body??'','PR body');
    checkText(current.headRefName??'','PR head');
  }else{
    const repo=JSON.parse(command(realGh,['repo','view',...(repository?[repository]:[]),'--json','url,defaultBranchRef'],cwd).toString('utf8'));
    if(!isGithub(repo.url??''))fail('github_repository_required');
    const branch=option(args,'--base','-B')??repo.defaultBranchRef?.name;
    if(typeof branch!=='string'||!branch||branch.startsWith('-')||/[\s\x00-\x1f]/.test(branch))fail('unverified_pr_base');
    checkText(branch,'PR base');checkText(head,'PR head');
    const advertised=git(['ls-remote','--heads','--',repo.url,`refs/heads/${branch}`],context).split('\n');
    if(advertised.length!==1)fail('unverified_pr_base');
    const fields=advertised[0].split(/\s+/);base=fields[0];
    if(!/^[a-f0-9]{40,64}$/.test(base)||fields[1]!==`refs/heads/${branch}`)fail('unverified_pr_base');
  }
  const replacementBase=option(args,'--base','-B');
  if(args[pos+1]==='edit'&&replacementBase)fail('explicit_pr_base_change_requires_create_review');
  checkRange(head,base,context);
  // Company/bio are unrelated profile metadata, not the publication identity.
  const profile=command(realGh,['api','user','--hostname','github.com','--jq','{login: .login}'],cwd);
  const account=JSON.parse(profile.toString('utf8'));
  if(typeof account.login!=='string'||!/^[a-z0-9-]+$/i.test(account.login))fail('unverified_github_account');
  checkText(account.login,'GitHub login');
  if(!policy().githubLogins.some(l=>l.toLowerCase()===account.login.toLowerCase()))fail('unapproved_github_account');
}
export function main(args=process.argv.slice(2)){
  const [mode,...rest]=args;
  if(mode==='--rules'){console.log(policy().terms.map((term,i)=>`${i+1}: ${term}`).join('\n'));return;}
  if(mode==='--index'){checkIndex();return;}
  if(mode==='--message'){
    if(protectedRepository()){checkIdentities();checkBuffer(readFileSync(rest[0]),'commit message');scanner().tree();}return;
  }
  if(mode==='--push'){checkPush(readFileSync(0,'utf8'),{},rest[1],rest[0]);return;}
  if(mode==='--head'){
    if(protectedRepository())checkRange(rest[0]??'HEAD',rest[1]??'HEAD^');return;
  }
  if(mode==='--ci'){
    if(!protectedRepository())fail('github_origin_required');
    if(rest[0]){
      const event=JSON.parse(readFileSync(rest[0],'utf8'));
      const head=event.pull_request?.head?.sha??event.after??'HEAD';
      const base=event.pull_request?.base?.sha??event.before;
      if(!/^[a-f0-9]{40,64}$/.test(head)||!base||! /^[a-f0-9]{40,64}$/.test(base))fail('unverified_ci_range');
      checkRange(head,base);
      if(event.pull_request){
        const pr=event.pull_request;
        for(const [key,value]of Object.entries({title:pr.title,body:pr.body,branch:pr.head?.ref,author:pr.user?.login})){
          if(typeof value==='string')checkText(value,`PR ${key}`);
        }
      }
    }else fail('ci_event_required');
    return;
  }
  if(mode==='--check-git'){checkGit(rest);return;}
  if(mode==='--check-gh'){checkGh(rest,process.cwd(),'gh');return;}
  if(mode==='--run-git'){
    const protect=checkGit(rest),p=splitGit(rest);
    const auth=protect&&p.name==='push'?['-c','url.https://github.com/.insteadOf=git@github.com:',
      '-c','url.https://github.com/.insteadOf=ssh://git@github.com/',
      '-c','credential.https://github.com.helper=',
      '-c','credential.https://github.com.helper=!gh auth git-credential']:[];
    const argv=protect?[...p.globals,...auth,'-c',`core.hooksPath=${hooksPath}`,p.name,...p.args]:rest;
    const r=spawnSync(gitBinary,argv,{env,stdio:'inherit'});process.exitCode=r.status??1;return;
  }
  if(mode==='--run-gh'){
    const binary='/usr/local/libexec/gh';checkGh(rest,process.cwd(),binary);
    const r=spawnSync(binary,rest,{env,stdio:'inherit'});process.exitCode=r.status??1;return;
  }
  fail('unknown_guard_mode');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{main();}catch(e){console.error(e.message?.startsWith('PUBLIC_REPOSITORY_GUARD[')?e.message:'PUBLIC_REPOSITORY_GUARD[inspection_failed]');process.exitCode=1;}
}
