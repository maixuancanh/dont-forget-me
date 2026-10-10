import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

it('refreshes an expired cookie once and uses the rotated CSRF token',async()=>{
 const elements=new Map<string,any>();
 const element=(key:string)=>{if(!elements.has(key))elements.set(key,{textContent:'',value:'',replaceChildren(){}});return elements.get(key);};
 const calls:any[]=[];let attempts=0,rotated=false;
 const fetch=async(path:string,options:any={})=>{
  calls.push({path,options});
  if(path==='/v1/auth/csrf')return {ok:true,status:200,json:async()=>({csrfToken:rotated?'new':'old'})};
  if(path==='/v1/auth/access'){expect(options.headers['X-CSRF-Token']).toBe('old');rotated=true;return {ok:true,status:200,json:async()=>({userId:'same-user'})};}
  if(path==='/v2/runs'){attempts++;return {ok:attempts===2,status:attempts===2?200:401,json:async()=>attempts===2?{runs:[]}:{error:'SESSION_INVALID'}};}
  throw Error('Unexpected request');
 };
 runInNewContext(await readFile(new URL('../../web/account/recovery.js',import.meta.url),'utf8'),{document:{querySelector:element},fetch,Option:class{},Error,JSON,encodeURIComponent});
 await element('#recovery-load').onclick();
 expect(attempts).toBe(2);expect(calls.filter(c=>c.path==='/v1/auth/access')).toHaveLength(1);
 expect(element('#recovery-status').textContent).toContain('Choose a case');
});
