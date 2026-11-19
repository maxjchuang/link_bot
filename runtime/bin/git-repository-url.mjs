/** Runtime equivalent of the host endpoint parser; shared test vectors cover parity. */
export function repositoryKey(value){
  if(typeof value!=='string'||value!==value.trim()||/[\s\x00-\x1f%\\]/.test(value)||/(?:^|\/)\.\.?(?:\/|$)/.test(value))return undefined;
  let host,path,port='';
  const scp=/^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+)$/.exec(value);
  if(scp&&!value.includes('://')){host=scp[1].toLowerCase();path=scp[2];}
  else{
    let url;try{url=new URL(value);}catch{return undefined;}
    if(!['https:','ssh:'].includes(url.protocol)||url.password||url.search||url.hash
      ||url.protocol==='https:'&&url.username||!url.hostname)return undefined;
    host=url.hostname.toLowerCase();path=url.pathname.slice(1);
    port=url.port&&!(url.protocol==='ssh:'&&url.port==='22')?`:${url.port}`:'';
  }
  if(!/^[a-zA-Z0-9._/-]+$/.test(path)||path.startsWith('/')
    ||path.split('/').some(p=>!p||p==='.'||p==='..'))return undefined;
  path=path.replace(/\.git$/,'');if(!path)return undefined;
  return `${host}${port}/${host==='github.com'?path.toLowerCase():path}`;
}

export function cloneFailure(stderr){
  if(/host key verification failed|remote host identification has changed|host_trust_required/i.test(stderr))return 'project_host_verification_required';
  if(/repository not found|does not (?:appear to )?exist|not a git repository|404/i.test(stderr))return 'project_repository_unavailable';
  if(/remote branch .* not found|couldn.t find remote ref|remote ref does not exist/i.test(stderr))return 'project_branch_missing';
  if(/permission denied|authentication failed|authorization failed|could not read username|publickey|auth_required/i.test(stderr))return 'project_authentication_required';
  if(/could not resolve|failed to connect|connection refused|timed? out|network is unreachable|ssl|tls/i.test(stderr))return 'project_network_failed';
  return 'project_clone_failed';
}
