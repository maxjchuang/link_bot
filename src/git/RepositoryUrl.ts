/** Parse a configured Git endpoint without guessing a hosting provider. */
export function repositoryKey(value:string):string|undefined{
  if(typeof value!=='string'||value!==value.trim()||/[\s\x00-\x1f%\\]/.test(value)||/(?:^|\/)\.\.?(?:\/|$)/.test(value))return undefined;
  let host:string,path:string,port='';
  const scp=/^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+)$/.exec(value);
  if(scp&&!value.includes('://')){host=scp[1]!.toLowerCase();path=scp[2]!;}
  else{
    let url:URL;try{url=new URL(value);}catch{return undefined;}
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
