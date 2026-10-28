const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {execFileSync}=require('node:child_process');
const {createLocalApiHandler}=require('../src/lib/local-api');
const version=require('../package.json').version;

test('macOS health probe accepts the real local handshake and rejects removed-account and HTML responses',{skip:process.platform!=='darwin',timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tt-native-health-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const handler=createLocalApiHandler({queuePath:path.join(dir,'tracker/queue.jsonl'),serverVersion:version,syncContext:{home:dir}});
 const server=http.createServer(async(req,res)=>{
  if(!await handler(req,res,new URL(req.url,'http://127.0.0.1'))){res.writeHead(404);res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const native=await fs.readFile(path.join(__dirname,'../TokenTrackerBar/TokenTrackerBar/Models/LocalServerHealth.swift'),'utf8');
 const route=native.match(/static let path = "([^"]+)"/)[1];
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+route);
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/application\/json/);
 const payload=await response.text();
 assert.equal(JSON.parse(payload).serverVersion,version);
 const removed=await fetch(base+'/functions/tokentracker-user-status');
 assert.equal(removed.status,404);
 const sample=path.join(dir,'handshake.json');
 await fs.writeFile(sample,payload,{mode:0o600});
 const harness=String.raw`
import Foundation
@main struct Verify {
 static func main() throws {
  let data=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
  let version=CommandLine.arguments[2]
  precondition(LocalServerHealth.isHealthy(data:data,statusCode:200,expectedVersion:version))
  precondition(!LocalServerHealth.isHealthy(data:data,statusCode:404,expectedVersion:version))
  precondition(!LocalServerHealth.isHealthy(data:data,statusCode:200,expectedVersion:"0.0.0"))
  precondition(!LocalServerHealth.isHealthy(data:Data("<html>dashboard</html>".utf8),statusCode:200,expectedVersion:version))
  precondition(!LocalServerHealth.isHealthy(data:Data("{}".utf8),statusCode:200,expectedVersion:version))
  let empty=try JSONSerialization.data(withJSONObject:["token":"","serverVersion":version])
  precondition(!LocalServerHealth.isHealthy(data:empty,statusCode:200,expectedVersion:version))
  print("native local handshake passed")
 }
}`;
 const main=path.join(dir,'Verify.swift'),exe=path.join(dir,'verify');
 await fs.writeFile(main,harness);
 execFileSync('/usr/bin/swiftc',['-parse-as-library',path.join(__dirname,'../TokenTrackerBar/TokenTrackerBar/Models/LocalServerHealth.swift'),main,'-o',exe],{stdio:'pipe',timeout:45000});
 assert.match(execFileSync(exe,[sample,version],{encoding:'utf8',timeout:5000}),/passed/);
 const api=await fs.readFile(path.join(__dirname,'../TokenTrackerBar/TokenTrackerBar/Services/APIClient.swift'),'utf8');
 const health=api.slice(api.indexOf('func checkServerHealth()'),api.indexOf('// MARK: - Private Helpers'));
 assert.match(health,/baseURL \+ LocalServerHealth.path/);
 assert.match(health,/LocalServerHealth.isHealthy/);
 assert.doesNotMatch(health,/tokentracker-user-status|"\/health"/);
});
