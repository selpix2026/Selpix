// Generate exactly the PowerShell source embedded in the delivered JSX.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let source=fs.readFileSync(path.join(__dirname,'../illustrator/CAD_Cleaner_v1.3.jsx'),'utf8')
 .replace(/^\uFEFF/,'').replace(/^#target[^\n]*\n/,'');
source=source.slice(0,source.indexOf("    var ui=new Window('dialog'"));
const context=vm.createContext({app:{documents:[{}],activeDocument:{}}});
vm.runInContext(source+'this.controllerSource=makeControlScript();})();',context);
fs.writeFileSync(process.argv[2], '\ufeff'+context.controllerSource);
