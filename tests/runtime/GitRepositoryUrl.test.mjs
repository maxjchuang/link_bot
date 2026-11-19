import {describe,expect,it} from 'vitest';
import {repositoryKey,cloneFailure} from '../../runtime/bin/git-repository-url.mjs';
import {repositoryKey as hostKey} from '../../src/git/RepositoryUrl.ts';
describe('sandbox Git endpoint and failure classification',()=>{
  it.each(['git@source.example:team/repo.git','https://source.example/team/repo.git','ssh://git@source.example:2222/team/repo.git',
    'https://github.com/Team/Repo.git','team/repo','file:///tmp/repo','https://source.example/a/../b','https://source.example/a/%2e%2e/b'])('matches host validation: %s',url=>expect(repositoryKey(url)).toBe(hostKey(url)));
  it.each([
    ['ERROR: Repository not found.','project_repository_unavailable'],
    ['fatal: Remote branch feature not found in upstream origin','project_branch_missing'],
    ['Permission denied (publickey).','project_authentication_required'],
    ['Host key verification failed.','project_host_verification_required'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!','project_host_verification_required'],
    ['Could not resolve host: source.example','project_network_failed'],
    ['ssh: connect to host source.example port 22: Connection refused','project_network_failed'],
    ['unexpected clone error','project_clone_failed'],
  ])('does not misreport every clone failure as missing login: %s',(stderr,code)=>expect(cloneFailure(stderr)).toBe(code));
});
