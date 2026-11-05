// Host-independent regression checks for Illustrator geometry planning.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const product = path.join(__dirname, '..', 'illustrator', 'CAD_Cleaner_v1.3.jsx');
function load() {
    let source = fs.readFileSync(product, 'utf8').replace(/^\uFEFF?#target illustrator\r?\n/, '');
    const ui = source.indexOf('    var ui=new Window(');
    assert.ok(ui > 0, 'JSX dialog boundary is available');
    source = source.slice(0, ui) + '\nglobalThis.cad={removeDups:removeDups,joinCandidates:joinCandidates,planChains:planChains,noopStats:noopStats,setTick:function(fn){tick=fn;},stop:function(){quitting=true;},limits:function(n){LIMIT_OUTPUT=n;}};\n})();';
    const context = {app:{documents:[{}],activeDocument:{}}, alert(){}, MAX_CHAIN_SOURCES:64};
    vm.createContext(context); vm.runInContext(source, context);
    context.cad.setTick(function(){});
    context.cad.limits(4000);
    return context.cad;
}
function pt(x,y=0) { return {a:[x,y],l:[x,y],r:[x,y],t:'CORNER'}; }
function rec(points,parent,style='same') { return {it:{},base:points,p:points,parent,style,closed:false,zero:false,dup:false,joined:false}; }
function parent(uuid='parent') { return {uuid,typename:'GroupItem'}; }
function join(cad, rows, tol=0.2) { const stats=cad.noopStats();return {stats,result:cad.joinCandidates(rows,{join:true,joinTol:tol},stats)}; }

test('duplicate lookup scales by style for coincident incompatible strokes', () => {
    const cad=load(), rows=[], p=parent();let reads=0;
    for(let i=0;i<1200;i++){const r=rec([pt(0),pt(10)],p);Object.defineProperty(r,'style',{get(){reads++;return 'style'+i;}});rows.push(r);}
    const stats=cad.noopStats();cad.removeDups(rows,stats,{dup:true});
    assert.equal(stats.dups,0);assert.ok(reads<1200*8,'style reads must be linear: '+reads);
});

test('duplicate lookup partitions different direct parents', () => {
    const cad=load(),rows=[];let reads=0;
    for(let i=0;i<1000;i++){const p=parent('p'+i),r=rec([pt(0),pt(10)],p);Object.defineProperty(r,'parent',{get(){reads++;return p;}});rows.push(r);}
    const stats=cad.noopStats();cad.removeDups(rows,stats,{dup:true});
    assert.equal(stats.dups,0);assert.ok(reads<1000*10,'parent reads must be linear: '+reads);
});

test('reverse duplicates retain handle orientation and delete only matching strokes', () => {
    const cad=load(),p=parent(),a=pt(0),b=pt(10);a.r=[2,3];b.l=[8,3];
    const reverse=[{a:[10,0],l:[10,0],r:[8,3],t:'CORNER'},{a:[0,0],l:[2,3],r:[0,0],t:'CORNER'}];
    const rows=[rec([a,b],p),rec(reverse,p),rec(reverse,parent('other')),rec(reverse,p,'other style')];
    const stats=cad.noopStats();cad.removeDups(rows,stats,{dup:true});
    assert.equal(stats.dups,1);assert.deepEqual(rows.map(r=>r.dup),[false,true,false,false]);
});

test('spatial join lookup scales by style at a shared endpoint', () => {
    const cad=load(),rows=[],p=parent();let reads=0;
    for(let i=0;i<1200;i++){const r=rec([pt(0),pt(10,i+1)],p);Object.defineProperty(r,'style',{get(){reads++;return 'style'+i;}});rows.push(r);}
    assert.equal(join(cad,rows).result.pairs.length,0);assert.ok(reads<1200*10,'style reads must be linear: '+reads);
});

test('spatial join lookup partitions direct parents', () => {
    const cad=load(),rows=[];let reads=0;
    for(let i=0;i<1000;i++){const p=parent('p'+i),r=rec([pt(0),pt(10,i+1)],p);Object.defineProperty(r,'parent',{get(){reads++;return p;}});rows.push(r);}
    assert.equal(join(cad,rows).result.pairs.length,0);assert.ok(reads<1000*10,'parent reads must be linear: '+reads);
});

test('a chain spanning every input record keeps its existing anchors', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0),pt(1)],p),rec([pt(1.1),pt(2)],p)];
    const {stats,result}=join(cad,rows,.2),plans=cad.planChains(rows,result,stats,{joinTol:.2});
    assert.equal(plans.length,1);assert.deepEqual(JSON.parse(JSON.stringify(plans[0].points.map(p=>p.a))),[[0,0],[1,0],[1.1,0],[2,0]]);
});

test('zero tolerance joins exactly coincident endpoints', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0),pt(1)],p),rec([pt(1),pt(2)],p)];
    assert.equal(join(cad,rows,0).result.pairs.length,1);
});

test('zero tolerance never rounds nearby endpoints into a join', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0),pt(1)],p),rec([pt(1+1e-7),pt(2)],p)];
    assert.equal(join(cad,rows,0).result.pairs.length,0);
});

test('zero tolerance does not treat squared-distance underflow as coincidence', () => {
    const cad=load(),p=parent(),rows=[rec([pt(-1),pt(0)],p),rec([pt(1e-200),pt(2)],p)];
    assert.equal(join(cad,rows,0).result.pairs.length,0);
});

test('competing endpoints remain separate', () => {
    const cad=load(),p=parent(),rows=[rec([pt(-1),pt(0)],p),rec([pt(0),pt(1)],p),rec([pt(0),pt(0,1)],p)];
    assert.equal(join(cad,rows,.01).result.pairs.length,0);
});

test('parallel alternate routes with both endpoint pairs nearby stay separate', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0),pt(10)],p),rec([pt(0,.05),pt(10,.05)],p)];
    assert.equal(join(cad,rows,.1).result.pairs.length,0);
});

test('closed path, zero, and duplicate protections survive join partitioning', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0),pt(1)],p),rec([pt(1),pt(2)],p),rec([pt(2),pt(3)],p),rec([pt(3),pt(4)],p)];
    rows[1].closed=true;rows[2].zero=true;rows[3].dup=true;
    assert.equal(join(cad,rows).result.pairs.length,0);
});

test('dense rejected candidates have a bounded comparison budget and return no partial joins', () => {
    const cad=load(),p=parent(),rows=[];let ticks=0;
    for(let i=0;i<1600;i++)rows.push(rec([pt(0),pt(10)],p));
    rows.push(rec([pt(100),pt(101)],p),rec([pt(101),pt(102)],p));
    cad.setTick(function(){ticks++;});const {stats,result}=join(cad,rows,.1);
    assert.equal(result.pairs.length,0);assert.ok(stats.cross>0,'comparison cap must be reported');assert.ok(ticks<12000,'scan should stop at its work cap');
});

test('long chains split into bounded plans while preserving every source path', () => {
    const cad=load(),p=parent(),rows=[];
    for(let i=0;i<130;i++)rows.push(rec([pt(i),pt(i+1)],p));
    const {stats,result}=join(cad,rows,.01),plans=cad.planChains(rows,result,stats,{joinTol:.01});
    assert.ok(plans.length>=3);assert.ok(plans.every(plan=>plan.src.length<=64));
    const covered=plans.flatMap(plan=>Array.from(plan.src));assert.equal(new Set(covered).size,130);
    for(const plan of plans){const expected=Array.from({length:plan.src.length+1},(_,i)=>[plan.src[0]+i,0]);assert.deepEqual(JSON.parse(JSON.stringify(plan.points.map(p=>p.a))),expected);}
});

test('join planning checks stop while building endpoint partitions', () => {
    const cad=load(),p=parent(),rows=[];let ticks=0;
    for(let i=0;i<1500;i++)rows.push(rec([pt(i*3),pt(i*3+1)],p));
    cad.setTick(function(){ticks++;cad.stop();});
    assert.equal(join(cad,rows).result.pairs.length,0);assert.ok(ticks>=1);
});

test('UUID-less Layers use stacking ancestry without quadratic parent lookups', () => {
    const cad=load(),rows=[],doc={typename:'Document'};let reads=0;
    for(let i=0;i<1000;i++){const p={typename:'Layer',zOrderPosition:i,parent:doc},r=rec([pt(0),pt(10)],p);Object.defineProperty(r,'parent',{get(){reads++;return p;}});rows.push(r);}
    const stats=cad.noopStats();cad.removeDups(rows,stats,{dup:true});
    assert.equal(stats.dups,0);assert.ok(reads<10000);
});

test('join budget preserves source paths when the resulting point count is too large', () => {
    const cad=load(),p=parent(),left=[],right=[];
    for(let i=0;i<2300;i++){left.push(pt(i/2299));right.push(pt(1+i/2299));}
    const rows=[rec(left,p),rec(right,p)],{stats,result}=join(cad,rows,.0001);
    assert.equal(result.pairs.length,0);assert.equal(cad.planChains(rows,result,stats,{joinTol:.0001}).length,0);
    assert.ok(rows.every(r=>!r.joined));assert.equal(rows[0].p.length,2300);assert.equal(rows[1].p.length,2300);
});

test('cycle breaking keeps the complete geometry as an open path', () => {
    const cad=load(),p=parent(),rows=[rec([pt(0,0),pt(1,0)],p),rec([pt(1,0),pt(.5,1)],p),rec([pt(.5,1),pt(0,0)],p)];
    const {stats,result}=join(cad,rows,0),plans=cad.planChains(rows,result,stats,{joinTol:0});
    assert.equal(result.pairs.length,2);assert.equal(plans.length,1);assert.equal(plans[0].src.length,3);assert.equal(plans[0].points.length,4);assert.equal(plans[0].closed,false);
});

test('stop during dense comparisons never returns an incomplete candidate graph', () => {
    const cad=load(),p=parent(),rows=[];let polled=false;
    for(let i=0;i<200;i++)rows.push(rec([pt(0),pt(10,i+1)],p));
    cad.setTick(function(label){if(label.indexOf('끝점 후보 확인')===0){polled=true;cad.stop();}});
    assert.equal(join(cad,rows,.1).result.pairs.length,0);assert.equal(polled,true);
});
