'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = process.env.JSX_SOURCE || path.join(__dirname, '../illustrator/CAD_Cleaner_v1.3.jsx');
function core() {
  let source=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').replace(/^#target[^\n]*\n/,'');
  source=source.slice(0,source.indexOf("    var ui=new Window('dialog'"));
  const state={now:10000,files:{},writes:0,reads:0,sleeps:0,alerts:[]};
  function File(name){this.fsName=name;this.name=name;}
  Object.defineProperty(File.prototype,'exists',{get(){return Object.hasOwn(state.files,this.name);}});
  File.prototype.open=function(mode){this.mode=mode;return true;};
  File.prototype.write=function(text){state.files[this.name]=text;state.writes++;};
  File.prototype.read=function(){state.reads++;return state.files[this.name]||'';};
  File.prototype.close=function(){};
  File.prototype.remove=function(){delete state.files[this.name];return true;};
  const context=vm.createContext({app:{documents:[{}],activeDocument:{groupItems:[]}},File,
    $:{os:'Windows',sleep(ms){state.sleeps++;state.now+=ms;if(state.sleeps>300)throw Error('unbounded wait');}},
    alert(text){state.alerts.push(text);},PointType:{CORNER:'corner'}});
  vm.runInContext(source+`this.api={run:function(s){return eval(s);}, applyPlan:applyPlan, tick:tick,
    requestState:requestState,endProgress:endProgress,makeControlScript:makeControlScript,makeRecords:makeRecords,
    markZeroAndSimplify:markZeroAndSimplify,commit:commit,sourceItems:sourceItems};})();`,context);
  context.state=state;
  context.api.run('currentMillis=function(){return state.now;};');
  context.api.run(`control={command:new File('command'),status:new File('status'),done:new File('done'),
    closed:new File('closed'),heartbeat:new File('heartbeat'),lastHeartbeat:'1',lastHeartbeatMs:state.now,
    files:[],dir:{remove:function(){return true;}}};`);
  state.files.command='RUN'; state.files.heartbeat='1';
  return {api:context.api,state,context};
}

test('completion after last mutation ignores PAUSE and emits terminal signal',()=>{
  const {api,state}=core();
  api.run(`startProgress=function(){quitting=false;paused=false;};
    deleteSafe=function(){operationsDone++;state.files.command='PAUSE';return true;};`);
  const prep={stats:{pathsRead:1,pointsRead:2,skipped:0},records:[{zero:true}],plans:[],opt:{groups:false}};
  api.applyPlan(prep);
  assert.ok(state.files.done || state.files.status.startsWith('FINAL|'));
  assert.ok(state.alerts.some(x=>x.includes('완료')));
  assert.ok(state.sleeps<30);
});

test('closed controller breaks a PAUSE safely instead of infinite waiting',()=>{
  const {api,state}=core();
  state.files.command='PAUSE'; state.files.closed='CLOSED';
  api.tick('work',50,true);
  assert.equal(api.run('quitting'),true);
});

test('stale heartbeat while paused requests safe stop within bounded wait',()=>{
  const {api,state}=core(); state.files.command='PAUSE';
  api.tick('work',50,true);
  assert.equal(api.run('quitting'),true);
  assert.ok(state.now<30000);
});

test('status IO remains time-throttled when legacy caller requests force',()=>{
  const {api,state}=core();
  for(let i=0;i<10000;i++)api.tick('scan',30,true);
  assert.ok(state.writes<20,`status writes: ${state.writes}`);
  assert.ok(state.reads<30,`file reads: ${state.reads}`);
});

test('finalization is bounded even if terminal flag cannot be written',()=>{
  const {api,state}=core();
  api.run(`var originalWriter=writeUTF8;writeUTF8=function(f,data){if(f.fsName==='done')return false;return originalWriter(f,data);};`);
  api.endProgress('done','완료');
  assert.equal(api.run('control'),null);
  assert.ok(state.files.status.startsWith('FINAL|'));
  assert.ok(state.sleeps<30);
});

test('processing error still finalizes once and emits completion report',()=>{
  const {api,state}=core();
  api.run(`startProgress=function(){quitting=false;};commit=function(){throw Error('test failure');};`);
  api.applyPlan({stats:{pathsRead:1,pointsRead:2,skipped:0},records:[],plans:[{}],opt:{groups:false}});
  assert.ok(state.files.done || state.files.status.startsWith('FINAL|'));
  assert.ok(state.alerts.some(x=>x.includes('실패')));
});

test('protected-only document scans still poll and honor STOP',()=>{
  const {api,state}=core();
  api.run(`doc.pathItems=[];for(var i=0;i<10000;i++)doc.pathItems.push({typename:'GroupItem'});`);
  state.files.command='STOP';
  api.makeRecords({selected:false},{skipped:0});
  assert.equal(api.run('quitting'),true);
});

test('same-coordinate handle corruption never deletes original path',()=>{
  const {api}=core();
  api.run(`originalDeletes=0;copyDeletes=0;p={a:[0,0],l:[0,0],r:[0,0],t:'corner'};
    ps=[{anchor:[0,0],leftDirection:[99,99],rightDirection:[0,0]},
    {anchor:[1,0],leftDirection:[1,0],rightDirection:[1,0]}];
    Object.defineProperty(ps[0],'leftDirection',{get:function(){return [99,99];},set:function(){}});
    copy={pathPoints:ps,stroked:true,setEntirePath:function(){},remove:function(){copyDeletes++;}};
    original={duplicate:function(){return copy;},remove:function(){originalDeletes++;}};
    records=[{it:original}];plan={src:[0],points:[p,{a:[1,0],l:[1,0],r:[1,0],t:'corner'}],closed:false};`);
  const result=api.run('commit(plan,records)');
  assert.equal(result,'failed');
  assert.equal(api.run('originalDeletes'),0);
  assert.equal(api.run('copyDeletes'),1);
});

test('original delete failure is reported as partial instead of complete success',()=>{
 const {api,state}=core();
 api.run(`startProgress=function(){quitting=false;};
   copy={stroked:true,pathPoints:[{anchor:[0,0],leftDirection:[0,0],rightDirection:[0,0]},
     {anchor:[1,0],leftDirection:[1,0],rightDirection:[1,0]}],setEntirePath:function(){},remove:function(){}};
   original={duplicate:function(){return copy;},remove:function(){throw Error('locked original');}};
   records=[{it:original,delta:1,curve:0}];
   plan={src:[0],points:[{a:[0,0],l:[0,0],r:[0,0],t:'corner'},{a:[1,0],l:[1,0],r:[1,0],t:'corner'}],closed:false,joins:0};`);
 const outcome=api.run('commit(plan,records)');
 assert.equal(outcome,'partial');
 api.run(`commit=function(){return 'partial';};`);
 api.applyPlan({stats:{pathsRead:1,pointsRead:3,skipped:0},records:api.run('records'),plans:[api.run('plan')],opt:{groups:false}});
 assert.ok(state.alerts.at(-1).includes('실패 1건'));
 assert.ok(state.alerts.at(-1).includes('오류 확인'));
});

test('failed rollback copy removal is recorded and not silently promised successful',()=>{
 const {api}=core();
 api.run(`original={duplicate:function(){return {setEntirePath:function(){throw Error('write failed');},remove:function(){throw Error('remove failed');}};}};
   records=[{it:original}];plan={src:[0],points:[{a:[0,0]},{a:[1,0]}],closed:false};`);
 assert.equal(api.run('commit(plan,records)'),'failed');
 assert.ok(api.run("sessionLog.join(' ')").includes('복제본'));
});
