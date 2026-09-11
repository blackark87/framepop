const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const elements=new Map();function el(s){if(!elements.has(s))elements.set(s,{innerHTML:'',textContent:'',value:'',classList:{add(){},remove(){}},showModal(){},close(){}});return elements.get(s)}
const ctx={console,URL,localStorage:{getItem(){return null},setItem(){}},document:{querySelector:el,addEventListener(){},createElement(){return{click(){}}}},location:{hash:'#story'},window:{addEventListener(){}},navigator:{},setTimeout(){return 1},clearTimeout(){}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(__dirname+'/dist/app.js','utf8'),ctx);
vm.runInContext(`
for(const name of Object.keys(views)){if(!views[name]().length)throw Error(name)}
state.imageApproved=true;running=true;for(let i=0;i<40&&running;i++)run();
if(state.statuses[6]!=='fail'||state.statuses[7]!=='waiting')throw Error('QC gate failed');
state.selected=6;act('retry');for(let i=0;i<6&&running;i++)run();
if(state.statuses[6]!=='pass'||state.statuses[7]==='waiting')throw Error('Retry did not resume');
stop();state=fresh();state.mode='로컬 전용';state.imageProvider='Grok Imagine';act('generateImage');
if(!document.querySelector('#toast').textContent.includes('차단'))throw Error('Policy gate failed');
for(const t of ['계정·모델','작업 배정','생성 서버','전송 정책']){state.settingsTab=t;if(!settingsBody().length)throw Error(t)}
`,ctx);console.log('Passed: screen rendering, sequential QC gate, failed-segment retry/resume, local image policy.');
