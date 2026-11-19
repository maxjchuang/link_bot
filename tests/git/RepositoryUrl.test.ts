import {describe,expect,it} from 'vitest';
import {repositoryKey} from '../../src/git/RepositoryUrl.js';

describe('explicit generic Git endpoints',()=>{
  it.each([
    ['https://source.example/team/repo.git','source.example/team/repo'],
    ['git@source.example:team/repo.git','source.example/team/repo'],
    ['ssh://git@source.example/team/repo.git','source.example/team/repo'],
    ['ssh://git@source.example:2222/team/repo.git','source.example:2222/team/repo'],
    ['https://github.com/Team/Repo.git','github.com/team/repo'],
    ['https://source.example/Team/Repo.git','source.example/Team/Repo'],
  ])('normalizes without provider guessing: %s',(url,key)=>expect(repositoryKey(url)).toBe(key));
  it.each(['team/repo','file:///tmp/repo','http://source.example/team/repo','https://token@source.example/a/b',
    'ssh://git:password@source.example/a/b','https://source.example/a/../b','https://source.example/a/%2e%2e/b',
    'https://source.example/a/b?token=value','git@source.example:../repo','--upload-pack=bad','git@source.example:a//b'])('rejects unsafe or incomplete input: %s',url=>expect(repositoryKey(url)).toBeUndefined());
});
