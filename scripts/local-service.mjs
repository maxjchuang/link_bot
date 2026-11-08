#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function receipt(root) { try { return JSON.parse(await readFile(resolve(root,'.link-bot/local-service.json'),'utf8')); } catch { return undefined; } }
async function owned(root, record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.nonce !== 'string') return false;
  const command = spawnSync('ps',['-p',String(record.pid),'-o','command='],{encoding:'utf8'});
  return command.status === 0 && command.stdout.includes(resolve(root,'scripts/start-local.mjs')) && command.stdout.includes(record.nonce);
}
export async function localServiceStatus(root) { const r=await receipt(root);return {running:await owned(root,r),pid:await owned(root,r)?r.pid:undefined}; }
export async function startLocalService(root,env) {
  const old=await receipt(root);if(await owned(root,old))return {running:true,pid:old.pid,alreadyRunning:true};
  const nonce=randomUUID();const log=await open(resolve(root,'.link-bot/local-service.log'),'a',0o600);
  const child=spawn(process.execPath,[resolve(root,'scripts/start-local.mjs'),`--service=${nonce}`],{cwd:root,env,detached:true,stdio:['ignore',log.fd,log.fd]});
  child.unref();await log.close();
  await writeFile(resolve(root,'.link-bot/local-service.json'),JSON.stringify({pid:child.pid,nonce,startedAt:new Date().toISOString()}),{mode:0o600});
  return {running:true,pid:child.pid,starting:true};
}
export async function stopLocalService(root) {
  const r=await receipt(root);if(await owned(root,r))process.kill(-r.pid,'SIGTERM');
  await unlink(resolve(root,'.link-bot/local-service.json')).catch(()=>undefined);return {stopped:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=process.cwd();const result=process.argv[2]==='stop'?await stopLocalService(root):await localServiceStatus(root);console.log(JSON.stringify(result));
}
