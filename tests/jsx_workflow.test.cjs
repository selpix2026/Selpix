'use strict';
// Illustrator/ScriptUI host adapter: native Adobe behavior is not emulated completely.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function runDrawing(segments){
 const source=fs.readFileSync(path.join(__dirname,'../illustrator/CAD_Cleaner_v1.3.jsx'),'utf8').replace(/^\uFEFF/,'').replace(/^#target[^\n]*\n/,'');
 const files={},events=[],alerts=[],widgets=[],native={writes:0,removed:0};let now=10000,launches=0,result;
 function File(name){this.fsName=name;}
 Object.defineProperty(File.prototype,'exists',{get(){return Object.hasOwn(files,this.fsName);}});
 File.prototype.open=function(){return true;};File.prototype.close=function(){};
 File.prototype.write=function(txt){
  files[this.fsName]=txt;
  if(this.fsName.endsWith('/done.flag')){events.push('terminal');files[this.fsName.replace('/done.flag','/closed.flag')]='CLOSED';}
 };
 File.prototype.read=function(){return files[this.fsName]||'';};
 File.prototype.execute=function(){launches++;const dir=this.fsName.slice(0,this.fsName.lastIndexOf('/'));
  files[dir+'/ready.flag']='READY';files[dir+'/heartbeat.txt']='1';return true;};
 File.prototype.remove=function(){delete files[this.fsName];return true;};
 function Folder(name){this.fsName=name;}
 Folder.temp={fsName:'/tmp/virtual-adobe'};Folder.prototype.create=function(){return true;};Folder.prototype.remove=function(){return true;};
 const doc={typename:'Document',pathItems:[],groupItems:[],selection:[]};
 function point(a){return {anchor:a.slice(),leftDirection:a.slice(),rightDirection:a.slice(),pointType:'corner'};}
 function item(coords){
  const it={typename:'PathItem',uuid:'p'+doc.pathItems.length,parent:doc,closed:false,stroked:true,filled:false,
   strokeColor:{typename:'RGBColor',red:0,green:0,blue:0},strokeWidth:1,strokeCap:'butt',strokeJoin:'miter',
   strokeMiterLimit:4,strokeDashOffset:0,strokeDashes:[],opacity:100,blendingMode:'normal',strokeOverprint:false,
   pathPoints:coords.map(point),duplicate(){return item(this.pathPoints.map(p=>p.anchor));},
   setEntirePath(data){this.pathPoints=data.map(point);},remove(){native.removed++;doc.pathItems.splice(doc.pathItems.indexOf(this),1);}};
  doc.pathItems.push(it);return it;
 }
 for(const segment of segments)item(segment);
 function Widget(type,text){this.type=type;this.text=text;this.value=false;this.enabled=true;widgets.push(this);}
 Widget.prototype.add=function(type,where,text){return new Widget(type,text);};
 Widget.prototype.notify=function(){};Widget.prototype.close=function(value){result=value;events.push('dialog-close');};
 Widget.prototype.show=function(){
  widgets.find(x=>x.text==='1. 검사 / 예상').onClick();
  const run=widgets.find(x=>x.text==='2. 정리 실행');
  if(result===undefined && run.enabled)run.onClick();
  return result;
 };
 function Window(type,text){Widget.call(this,type,text);}Window.prototype=Widget.prototype;
 function Clock(){this.getTime=()=>now;}Clock.now=()=>now;
 const context=vm.createContext({app:{documents:[doc],activeDocument:doc},File,Folder,Window,Date:Clock,
  $:{os:'Windows',sleep(ms){now+=ms;if(now>40000)throw Error('unexpected wait');}},
  alert(text){alerts.push(text);},confirm(){return true;},PointType:{CORNER:'corner'}});
 vm.runInContext(source,context,{timeout:5000});
 return {doc,events,alerts,files,launches,widgets,native};
}

test('full JSX analyzes and applies reversed duplicate, then closes all owned progress sessions',()=>{
 const r=runDrawing([[[0,0],[10,0]],[[10,0],[0,0]],[[0,2],[10,2]]]);
 assert.equal(r.doc.pathItems.length,2);
 assert.equal(r.native.removed,1);
 assert.equal(r.launches,2);
 assert.equal(r.events.filter(x=>x==='terminal').length,2);
 assert.equal(Object.keys(r.files).length,0);
 assert.equal(r.alerts.length,1);
 assert.ok(r.alerts[0].includes('정리 완료'));
 assert.ok(r.alerts[0].includes('중복 1개'));
});

test('full JSX no-op analysis closes main box and explicitly reports no changes',()=>{
 const r=runDrawing([[[0,0],[10,0]]]);
 assert.equal(r.doc.pathItems.length,1);assert.equal(r.native.removed,0);
 assert.equal(r.launches,1);assert.equal(r.events.filter(x=>x==='dialog-close').length,1);
 assert.ok(r.alerts[0].includes('정리할 대상이 없습니다'));
 assert.equal(Object.keys(r.files).length,0);
});
