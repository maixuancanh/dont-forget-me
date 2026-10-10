import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
class Element {
 value='';textContent='';disabled=false;open=false;children:Element[]=[];onclick:any;onchange:any;
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(...children:Element[]){this.children=children;if(children[0])this.value=children[0].value;}
 showModal(){this.open=true;}close(){this.open=false;}
}
const accountId='11111111-1111-4111-8111-111111111111';
async function browser(options:{sender?:string,execute?:()=>Promise<any>,preview?:()=>Promise<any>,signedBytes?:string,lifecyclePrepare?:()=>Promise<any>}={}){
 const elements=new Map<string,Element>();const element=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
 const calls:Array<{path:string,body:any}>=[];let register:any;let executions=0;let signs=0;
 const wallet={name:'Fixture wallet',features:{'sui:signPersonalMessage':{signPersonalMessage:async()=>({signature:'owner-signature'})},'sui:signTransaction':{signTransaction:async()=>{signs++;return {signature:'delete-signature',bytes:options.signedBytes??'exact-bytes'};}},'standard:connect':{connect:async()=>({accounts:[{address:'0x1',chains:['sui:mainnet']}]})},'sui:signAndExecuteTransaction':{signAndExecuteTransaction:async()=>{executions++;return options.execute?options.execute():{digest:'fixture-digest'};}}}};
 const fetch=async(path:string,input:any)=>{
  const body=input.body?JSON.parse(input.body):undefined;calls.push({path,body});let result:any={};
  if(path==='/v1/auth/me')result={csrfToken:'fixture'};
  if(path==='/v2/ownership/accounts')result={accounts:[{id:accountId,account_id:'0xaccount',status:'delegate_granted'}],activeRuns:[]};
  if(path.endsWith('/lifecycle/sources'))result={sources:[{id:'source-one',kind:'evidence',text:'Selected',objectIds:['0xobject'],blobIds:['blob-one']}]};
  if(path.endsWith('/wallet/challenge'))result={id:'challenge-one',message:'exact owner challenge'};
  if(path.endsWith('/delete/prepare')||path.endsWith('/renew/prepare'))result=options.lifecyclePrepare?await options.lifecyclePrepare():{operationId:'operation-one',confirmationHash:'hash',chain:'sui:mainnet',transactionJson:JSON.stringify({sender:options.sender??'0x1'}),txBytes:'exact-bytes',objects:[{owner:'0x1'}]};
  if(path==='/v2/runs')result={runs:[{id:'run-one'},{id:'run-two'}]};
  if(path.endsWith('/grant/prepare'))result={chain:'sui:mainnet',transactionJson:JSON.stringify({sender:options.sender??'0x1'}),intentId:'fixture-intent',disclosure:'Fixture grant'};
  if(path.endsWith('/ownership/preview'))result=options.preview?await options.preview():{id:'migration-one',supported:true,confirmationHash:'fixture'};
  if(path.endsWith('/ownership/migration-one/confirm'))result={status:'verified'};
  return {ok:true,json:async()=>result};
 };
 const source=await readFile(new URL('../../web/account/wallet.js',import.meta.url),'utf8');
 await runInNewContext(source,{document:{querySelector:element,createElement:()=>new Element()},window:{addEventListener:(_name:string,fn:any)=>{register=fn;},dispatchEvent:(event:any)=>event.detail.register(wallet)},CustomEvent:class{detail:any;constructor(_name:string,options:any){this.detail=options.detail;}},Option:class extends Element{constructor(text:string,value:string){super();this.textContent=text;this.value=value;}},fetch,TextEncoder,JSON,Set,Error,encodeURIComponent});
 void register;
 return {element,calls,executions:()=>executions,signs:()=>signs};
}
it('submits a granted delegate wallet transaction at most once despite double confirmation',async()=>{
 let finish:any;const pending=new Promise(resolve=>{finish=resolve;});
 const ui=await browser({execute:()=>pending});ui.element('#wallet-list').value='Fixture wallet';await ui.element('#wallet-connect').onclick();
 const grant=ui.element('#personal-accounts').children[0].children.find(x=>x.textContent==='Prepare grant')!;await grant.onclick();
 const confirm=ui.element('#wallet-confirm').onclick;const first=confirm();await confirm();expect(ui.executions()).toBe(1);
 finish({digest:'fixture-digest'});await first;expect(ui.calls.filter(x=>x.path.endsWith('/grant/confirm'))).toHaveLength(1);
});
it('denies a mismatched transaction sender before opening wallet execution',async()=>{
 const ui=await browser({sender:'0x2'});ui.element('#wallet-list').value='Fixture wallet';await ui.element('#wallet-connect').onclick();
 const grant=ui.element('#personal-accounts').children[0].children.find(x=>x.textContent==='Prepare grant')!;await grant.onclick();
 expect(ui.element('#wallet-status').textContent).toContain('wallet that owns');expect(ui.element('#wallet-consent').open).toBe(false);expect(ui.executions()).toBe(0);
});
it('discards a delayed migration preview when selection changes away and back',async()=>{
 let finish:any;const pending=new Promise(resolve=>{finish=resolve;});const ui=await browser({preview:()=>pending});
 const request=ui.element('#migration-preview').onclick();
 ui.element('#migration-run').value='run-two';ui.element('#migration-run').onchange();ui.element('#migration-run').value='run-one';ui.element('#migration-run').onchange();
 finish({id:'migration-one',supported:true,confirmationHash:'fixture'});await request;
 expect(ui.element('#migration-confirm').disabled).toBe(true);expect(ui.element('#migration-review').textContent).toBe('');
});

async function selectedLifecycle(options:Parameters<typeof browser>[0]={}){const ui=await browser(options);ui.element('#wallet-list').value='Fixture wallet';await ui.element('#wallet-connect').onclick();await ui.element('#lifecycle-load').onclick();const source=ui.element('#lifecycle-sources').children[0].children[0];(source as any).checked=true;source.onchange();return ui;}
it('requires frozen preview consent and submits exact sponsored bytes once',async()=>{const ui=await selectedLifecycle();await ui.element('#lifecycle-delete').onclick();await ui.element('#lifecycle-confirm').onclick();expect(ui.signs()).toBe(0);(ui.element('#lifecycle-consent') as any).checked=true;ui.element('#lifecycle-consent').onchange();const confirm=ui.element('#lifecycle-confirm').onclick;await Promise.all([confirm(),confirm()]);expect(ui.signs()).toBe(1);expect(ui.calls.filter(c=>c.path.endsWith('/delete/operation-one/submit'))).toHaveLength(1);expect(ui.calls.find(c=>c.path.endsWith('/submit'))?.body).toEqual({confirmationHash:'hash',signature:'delete-signature',bytes:'exact-bytes'});});
it('rejects bytes changed by wallet',async()=>{const ui=await selectedLifecycle({signedBytes:'modified'});await ui.element('#lifecycle-delete').onclick();(ui.element('#lifecycle-consent') as any).checked=true;await ui.element('#lifecycle-confirm').onclick();expect(ui.calls.some(c=>c.path.endsWith('/submit'))).toBe(false);expect(ui.element('#wallet-status').textContent).toContain('different transaction bytes');});
it('executes renewal and submits digest for effects verification',async()=>{const ui=await selectedLifecycle();ui.element('#lifecycle-epochs').value='2';ui.element('#lifecycle-ceiling').value='500';await ui.element('#lifecycle-renew').onclick();(ui.element('#lifecycle-consent') as any).checked=true;await ui.element('#lifecycle-confirm').onclick();expect(ui.executions()).toBe(1);expect(ui.calls.find(c=>c.path.endsWith('/renew/operation-one/confirm'))?.body).toEqual({confirmationHash:'hash',digest:'fixture-digest'});});
it('discards delayed lifecycle preview after case selection changes away and back',async()=>{let finish:any;const pending=new Promise(resolve=>{finish=resolve;});const ui=await selectedLifecycle({lifecyclePrepare:()=>pending});const work=ui.element('#lifecycle-delete').onclick();await new Promise(resolve=>setTimeout(resolve,0));ui.element('#lifecycle-run').value='run-two';ui.element('#lifecycle-run').onchange();ui.element('#lifecycle-run').value='run-one';ui.element('#lifecycle-run').onchange();finish({operationId:'operation-one',confirmationHash:'hash',chain:'sui:mainnet',transactionJson:JSON.stringify({sender:'0x1'}),txBytes:'exact-bytes'});await work;expect(ui.element('#lifecycle-confirm').disabled).toBe(true);expect(ui.element('#lifecycle-review').textContent).toBe('');});
it('rejects lifecycle transaction sender mismatch before confirmation',async()=>{const ui=await selectedLifecycle({sender:'0x2'});await ui.element('#lifecycle-delete').onclick();expect(ui.element('#lifecycle-confirm').disabled).toBe(true);expect(ui.element('#wallet-status').textContent).toContain('sender does not match');expect(ui.signs()).toBe(0);});
