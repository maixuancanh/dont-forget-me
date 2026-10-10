import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { OidcFlow } from "../src/auth/oidc.js";
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"dfm-oidc-test-")),store=new Store(join(dir,"state.json"));await store.init();
 let calls=0,now=1000000,nonceOverride:string|undefined;
 const flow=new OidcFlow(store,{issuer:"https://issuer.test",clientId:"game",authorizationEndpoint:"https://issuer.test/authorize",redirectUri:"https://game.test/callback"},
  {async exchange(input){calls++;expect(input.verifier.length).toBeGreaterThanOrEqual(43);return {issuer:"https://issuer.test",subject:"one",name:"One",nonce:nonceOverride??input.nonce};}},()=>now);
 return {flow,calls:()=>calls,advance:()=>{now+=600001;},badNonce:()=>{nonceOverride="forged";},close:async()=>{await store.close();await rm(dir,{recursive:true,force:true});}};
}
it("uses PKCE S256 and binds callback state to initiating browser",async()=>{
 const f=await fixture();try{
  const start=await f.flow.begin();const url=new URL(start.authorizationUrl);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");expect(url.searchParams.get("redirect_uri")).toBe("https://game.test/callback");
  await expect(f.flow.complete(start.state,"code","wrong-browser")).rejects.toThrow("OIDC_FLOW_INVALID");expect(f.calls()).toBe(0);
  const identity=await f.flow.complete(start.state,"code",start.browserBinding);expect(identity.subject).toBe("one");
  await expect(f.flow.complete(start.state,"code",start.browserBinding)).rejects.toThrow("OIDC_FLOW_INVALID");expect(f.calls()).toBe(1);
 }finally{await f.close();}
});
it("rejects expired state before contacting provider",async()=>{
 const f=await fixture();try{const start=await f.flow.begin();f.advance();await expect(f.flow.complete(start.state,"code",start.browserBinding)).rejects.toThrow("OIDC_FLOW_INVALID");expect(f.calls()).toBe(0);}finally{await f.close();}
});
it("rejects mismatched nonce after provider exchange",async()=>{
 const f=await fixture();try{const start=await f.flow.begin();f.badNonce();await expect(f.flow.complete(start.state,"code",start.browserBinding)).rejects.toThrow("OIDC_IDENTITY_INVALID");}finally{await f.close();}
});
it("consumes callback state atomically for concurrent requests",async()=>{
 const f=await fixture();try{const start=await f.flow.begin();const results=await Promise.allSettled([f.flow.complete(start.state,"code",start.browserBinding),f.flow.complete(start.state,"code",start.browserBinding)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.calls()).toBe(1);}finally{await f.close();}
});
it('permits a Google loopback callback only through explicit development opt-in',async()=>{
 const f=await fixture();const dir=await mkdtemp(join(tmpdir(),'dfm-loopback-')),store=new Store(join(dir,'state.json'));await store.init();
 const options={issuer:'https://accounts.google.com',clientId:'fixture-google-client',authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',redirectUri:'http://127.0.0.1:8798/v1/auth/callback'};
 const adapter={async exchange(){throw new Error('NOT_CALLED');}};
 try{
  expect(()=>new OidcFlow(store,options,adapter)).toThrow('OIDC_HTTPS_REQUIRED');
  const flow=new OidcFlow(store,{...options,allowLoopbackRedirect:true},adapter);
  expect(new URL((await flow.begin()).authorizationUrl).searchParams.get('redirect_uri')).toBe(options.redirectUri);
  for(const redirectUri of ['http://localhost.attacker.test/callback','http://127.0.0.2/callback','http://localhost@attacker.test/callback'])expect(()=>new OidcFlow(store,{...options,redirectUri,allowLoopbackRedirect:true},adapter)).toThrow('OIDC_HTTPS_REQUIRED');
 }finally{await f.close();await store.close();await rm(dir,{recursive:true,force:true});}
});
