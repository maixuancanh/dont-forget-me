import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { SessionService } from "../src/auth/session.js";

async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),"dfm-session-test-"));
  const store=new Store(join(directory,"state.json")); await store.init();
  let now=Date.parse("2026-10-09T00:00:00Z");
  const service=new SessionService(store,()=>now);
  return {store,service,advance:(ms:number)=>{now+=ms;},close:async()=>{await store.close();await rm(directory,{recursive:true,force:true});}};
}
it("links verified second identity only with active current session and refuses another account identity",async()=>{const f=await fixture();try{const a=await f.service.issue({issuer:"https://issuer.test",subject:"a",name:"A"});await f.service.link(a.accessToken,{issuer:"https://issuer.test",subject:"b",name:"B"});expect((await f.service.issue({issuer:"https://issuer.test",subject:"b",name:"B"})).userId).toBe(a.userId);const other=await f.service.issue({issuer:"https://issuer.test",subject:"other",name:"Other"});await expect(f.service.link(a.accessToken,{issuer:"https://issuer.test",subject:"other",name:"Other"})).rejects.toThrow("IDENTITY_ALREADY_LINKED");await f.service.logout(a.accessToken);await expect(f.service.link(a.accessToken,{issuer:"https://issuer.test",subject:"c",name:"C"})).rejects.toThrow("SESSION_INVALID");expect(other.userId).not.toBe(a.userId);}finally{await f.close();}});
it("persists issuer-subject identity across service restart without depending on a signing secret",async()=>{
  const f=await fixture();try{
    const first=await f.service.issue({issuer:"https://issuer.test",subject:"person-1",name:"One"});
    const second=await new SessionService(f.store).issue({issuer:"https://issuer.test",subject:"person-1",name:"Renamed"});
    const other=await f.service.issue({issuer:"https://other.test",subject:"person-1",name:"One"});
    expect(first.userId).toBe(second.userId);expect(other.userId).not.toBe(first.userId);
    expect((await f.service.authenticate(first.accessToken)).userId).toBe(first.userId);
  }finally{await f.close();}
});
it("stores only token digests and rejects expired access tokens",async()=>{
  const f=await fixture();try{
    const s=await f.service.issue({issuer:"https://issuer.test",subject:"person-1",name:"One"});
    const saved=JSON.stringify(await f.store.transact(state=>state));
    expect(saved).not.toContain(s.accessToken);expect(saved).not.toContain(s.refreshToken);
    f.advance(15*60*1000);await expect(f.service.authenticate(s.accessToken)).rejects.toThrow("SESSION_INVALID");
  }finally{await f.close();}
});
it("rotates refresh once and persists family revocation on replay",async()=>{
  const f=await fixture();try{
    const a=await f.service.issue({issuer:"https://issuer.test",subject:"person-1",name:"One"});
    const b=await f.service.refresh(a.refreshToken);
    await expect(f.service.authenticate(a.accessToken)).rejects.toThrow("SESSION_INVALID");
    expect((await f.service.authenticate(b.accessToken)).userId).toBe(a.userId);
    await expect(f.service.refresh(a.refreshToken)).rejects.toThrow("REFRESH_REPLAY");
    await expect(f.service.authenticate(b.accessToken)).rejects.toThrow("SESSION_INVALID");
    await expect(new SessionService(f.store).refresh(b.refreshToken)).rejects.toThrow("SESSION_INVALID");
  }finally{await f.close();}
});
it("concurrent refresh cannot produce two valid sessions",async()=>{
  const f=await fixture();try{
    const a=await f.service.issue({issuer:"https://issuer.test",subject:"person-1",name:"One"});
    const results=await Promise.allSettled([f.service.refresh(a.refreshToken),f.service.refresh(a.refreshToken)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const winner=results.find(r=>r.status==="fulfilled");
    if(winner?.status==="fulfilled")await expect(f.service.authenticate(winner.value.accessToken)).rejects.toThrow();
  }finally{await f.close();}
});
it("logout revokes one device while keeping another device for the same user",async()=>{
  const f=await fixture();try{
    const identity={issuer:"https://issuer.test",subject:"person-1",name:"One"};
    const a=await f.service.issue(identity),b=await f.service.issue(identity);
    await f.service.logout(a.accessToken);
    await expect(f.service.refresh(a.refreshToken)).rejects.toThrow("SESSION_INVALID");
    expect((await f.service.authenticate(b.accessToken)).userId).toBe(a.userId);
  }finally{await f.close();}
});
