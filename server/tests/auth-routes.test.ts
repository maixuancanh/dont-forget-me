import {it,expect} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash,randomBytes} from "node:crypto";
import {createApp} from "../src/app.js";
import {schema} from "../src/config.js";
it("binds OIDC callback, exchanges desktop proof once, isolates users and revokes logout",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"dfm-routes-"));
 const c=schema.parse({SESSION_SECRET:"x".repeat(32),DATA_FILE:join(dir,"state.json"),ALLOWED_ORIGIN:"https://game.test",AUTH_ISSUER:"https://issuer.test",AUTH_AUDIENCE:"client",AUTH_JWKS_URL:"https://issuer.test/jwks",OIDC_AUTHORIZATION_ENDPOINT:"https://issuer.test/auth",OIDC_TOKEN_ENDPOINT:"https://issuer.test/token",OIDC_REDIRECT_URI:"https://game.test/v1/auth/callback"});
 const {app}=await createApp(c,undefined,{exchange:async input=>({issuer:c.AUTH_ISSUER!,subject:input.code,name:"Player",nonce:input.nonce})});
 try{
 const login=await app.inject({url:"/v1/auth/login"});const authorization=new URL(login.json().authorizationUrl);const binding=String(login.headers["set-cookie"]).split(";")[0];
 expect(login.headers["set-cookie"]).toContain("HttpOnly; Secure; SameSite=Lax");
 expect((await app.inject({url:`/v1/auth/callback?state=${authorization.searchParams.get("state")}&code=alice`})).statusCode).toBe(401);
 const callback=await app.inject({url:`/v1/auth/callback?state=${authorization.searchParams.get("state")}&code=alice`,headers:{cookie:binding}});expect(callback.statusCode).toBe(302);
 const jar=(callback.headers["set-cookie"] as string[]).map(x=>x.split(";")[0]).join("; ");const me=await app.inject({url:"/v1/auth/me",headers:{cookie:jar}});expect(me.statusCode).toBe(200);const csrf=me.json().csrfToken;
 const webAccess=await app.inject({method:"POST",url:"/v1/auth/access",headers:{cookie:jar,origin:c.ALLOWED_ORIGIN!,"x-csrf-token":csrf},payload:{}});expect(webAccess.statusCode).toBe(200);expect(webAccess.json().refreshToken).toBeUndefined();expect(webAccess.json().accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
 const proof=randomBytes(32).toString("base64url");const challenge=createHash("sha256").update(proof).digest("hex");
 expect((await app.inject({method:"POST",url:"/v1/auth/handoff",headers:{cookie:jar},payload:{challenge}})).statusCode).toBe(403);
 const handoff=await app.inject({method:"POST",url:"/v1/auth/handoff",headers:{cookie:jar,origin:c.ALLOWED_ORIGIN!,"x-csrf-token":csrf},payload:{challenge}});expect(handoff.statusCode).toBe(200);const code=handoff.json().code;
 expect((await app.inject({method:"POST",url:"/v1/auth/exchange",payload:{code,proof:randomBytes(32).toString("base64url")}})).statusCode).toBe(401);
 const exchanged=await app.inject({method:"POST",url:"/v1/auth/exchange",payload:{code,proof}});expect(exchanged.statusCode).toBe(200);const access=exchanged.json().accessToken;
 expect((await app.inject({method:"POST",url:"/v1/auth/exchange",payload:{code,proof}})).statusCode).toBe(401);
 const run=await app.inject({method:"POST",url:"/v1/runs",headers:{authorization:"Bearer "+access},payload:{}});expect(run.statusCode).toBe(200);
 expect((await app.inject({url:"/v1/runs/"+run.json().run.id})).statusCode).toBe(401);
 await app.inject({method:"POST",url:"/v1/auth/logout",headers:{authorization:"Bearer "+access},payload:{}});
 expect((await app.inject({url:"/v1/runs/"+run.json().run.id,headers:{authorization:"Bearer "+access}})).statusCode).toBe(401);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
