import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
const root=process.cwd();
const { UserSandboxDockerRuntime }=await import(root+'/dist/src/runtime/UserSandboxDockerRuntime.js');
const { ExecDockerCommandRunner }=await import(root+'/dist/src/runtime/DockerRuntime.js');
const { SandboxSupervisorClient }=await import(root+'/dist/src/runtime/SandboxSupervisorClient.js');
const { userSandboxAppServerRuntimeFactory }=await import(root+'/dist/src/appserver/UserSandboxAppServerRuntime.js');
const runner=new ExecDockerCommandRunner();
const bridgeRoot=await mkdtemp(join(tmpdir(),'link-bot-container-smoke-'));
const runtime=new UserSandboxDockerRuntime({ image:'link-bot-runtime:0.1',transport:'docker-exec',bridgeRoot,
 cpuLimit:2,memoryLimitBytes:2147483648,pidLimit:512,tmpfsLimitBytes:268435456,network:'bridge',maxAppServersPerUser:4,
 hostUid:process.getuid(),hostGid:process.getgid() },runner);
const record={id:'sandbox_local_smoke',ownerId:'ou_fixture_smoke_'+randomBytes(5).toString('hex'),generation:1};
const described=runtime.describe(record);const streams=[];
try{
 const provisioned=await runtime.provision(record);
 const same=await runtime.provision(record);
 const supervisor=new SandboxSupervisorClient(provisioned.supervisorSocketPath);
 const factory=userSandboxAppServerRuntimeFactory({resolveTarget:()=>({sandboxGeneration:1,supervisorSocketPath:provisioned.supervisorSocketPath})});
 for(const taskId of ['task_smoke_one','task_smoke_two']){
  const stream=await factory({taskId,cwd:`/workspace/tasks/${taskId}`,args:[]},1);streams.push(stream);
  await stream.connection.initialize('0.1.0',{experimentalApi:true});
 }
 const tasks=await supervisor.listTasks();
 const containers=await runner.run(['ps','--filter',`name=${described.containerName}`,'--format','{{.ID}}']);
 await runner.run(['exec','--user','10001:10001',described.containerName,'node','-e',"require('fs').writeFileSync('/workspace/.local-smoke','fixture')"]);
 const persisted=await runner.run(['exec','--user','10001:10001',described.containerName,'node','-e',"process.stdout.write(require('fs').readFileSync('/workspace/.local-smoke','utf8'))"]);
 const result={realDocker:true,transport:'docker-exec',sameUserContainerReused:provisioned.containerId===same.containerId,
  runningUserContainers:containers.stdout.trim().split('\n').filter(Boolean).length,taskProcesses:tasks.length,
  workspacePersistence: persisted.stdout==='fixture',modelInferenceCalls:0,feishuMessagesSent:0};
 console.log(JSON.stringify(result));
}finally{
 for(const stream of streams)await stream.close().catch(()=>undefined);
 await runner.run(['rm','--force',described.containerName],{allowFailure:true}).catch(()=>undefined);
 for(const volume of [described.workspaceVolume,described.cacheVolume,described.homeVolume,described.codexVolume,described.agentsVolume]){
  await runner.run(['volume','rm',volume],{allowFailure:true}).catch(()=>undefined);
 }
}
