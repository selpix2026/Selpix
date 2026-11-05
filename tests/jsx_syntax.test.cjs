'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),acorn=require('acorn');
test('single JSX parses as ES3 after the Illustrator target directive',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../illustrator/CAD_Cleaner_v1.3.jsx'),'utf8').replace(/^\uFEFF/,'').replace(/^#target[^\n]*\n/,'');
 assert.doesNotThrow(()=>acorn.parse(source,{ecmaVersion:3}));
});
