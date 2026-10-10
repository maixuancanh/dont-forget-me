import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { Config } from "../config.js";
import type { Store } from "../store.js";
import { SessionService, type IssuedSession } from "./session.js";
import { OidcFlow, type OidcExchange } from "./oidc.js";
import { OidcProvider } from "./oidc-provider.js";
const random=()=>randomBytes(32).toString("base64url");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export const authCookies=(req:FastifyRequest)=>Object.fromEntries((req.headers.cookie??"").split(";").map(x=>x.trim().split("=")).filter(x=>x.length===2));
const cookies=authCookies;
export function validateCookieCsrf(req:FastifyRequest,c:Config){const jar=cookies(req),value=req.headers["x-csrf-token"];if(req.headers.origin!==c.ALLOWED_ORIGIN||typeof value!=="string"||!jar.dfm_csrf||value.length!==jar.dfm_csrf.length||!timingSafeEqual(Buffer.from(value),Buffer.from(jar.dfm_csrf)))throw Object.assign(new Error("CSRF_INVALID"),{statusCode:403});}
export function registerAuthRoutes(app:FastifyInstance,c:Config,store:Store,sessions:SessionService,adapter?:OidcExchange){
 app.get('/account/recovery.js',async(_req,reply)=>reply.type('text/javascript').send(await readFile(new URL('../../../web/account/recovery.js',import.meta.url),'utf8')));
 const redirect=c.OIDC_REDIRECT_URI?new URL(c.OIDC_REDIRECT_URI):undefined;
 const localDevelopment=c.APP_MODE==='development'&&redirect?.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(redirect.hostname)&&!redirect.username&&!redirect.password;
 const cookie=(name:string,value:string,age:number)=>`${name}=${value}; Path=/; HttpOnly;${localDevelopment?'':' Secure;'} SameSite=Lax; Max-Age=${age}`;
 app.get("/account/",async(_req,reply)=>reply.type("text/html").header("Content-Security-Policy","default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'").send(await readFile(new URL("../../../web/account/index.html",import.meta.url),"utf8")));
 app.get("/account/auth.js",async(_req,reply)=>reply.type("text/javascript").send(await readFile(new URL("../../../web/account/auth.js",import.meta.url),"utf8")));
 app.get("/account/wallet.js",async(_req,reply)=>reply.type("text/javascript").send(await readFile(new URL("../../../web/account/wallet.js",import.meta.url),"utf8")));
 // Google's web clients require a secret at token exchange, even with PKCE.
 const enabled=Boolean(c.AUTH_ISSUER&&c.AUTH_AUDIENCE&&c.AUTH_JWKS_URL&&c.OIDC_AUTHORIZATION_ENDPOINT&&c.OIDC_TOKEN_ENDPOINT&&c.OIDC_REDIRECT_URI&&(c.AUTH_ISSUER!=='https://accounts.google.com'||c.OIDC_CLIENT_SECRET));
 const flow=enabled?new OidcFlow(store,{issuer:c.AUTH_ISSUER!,clientId:c.AUTH_AUDIENCE!,authorizationEndpoint:c.OIDC_AUTHORIZATION_ENDPOINT!,redirectUri:c.OIDC_REDIRECT_URI!,allowLoopbackRedirect:localDevelopment},adapter??new OidcProvider({issuer:c.AUTH_ISSUER!,clientId:c.AUTH_AUDIENCE!,jwksUri:c.AUTH_JWKS_URL!,tokenEndpoint:c.OIDC_TOKEN_ENDPOINT!,clientSecret:c.OIDC_CLIENT_SECRET})):undefined;
 const limits=new Map<string,{count:number;expires:number}>();
 app.addHook("onRequest",async(req,reply)=>{
  if(!req.url.startsWith("/v1/auth/"))return;
  reply.header("Cache-Control","no-store").header("Referrer-Policy","no-referrer");
  const now=Date.now();for(const [key,row]of limits)if(row.expires<=now)limits.delete(key);
  const key=req.ip+":"+req.routeOptions.url;let row=limits.get(key);if(!row){row={count:0,expires:now+60000};limits.set(key,row);}
  if(++row.count>30)return reply.code(429).send({error:"AUTH_RATE_LIMIT"});
 });
 const bearer=(req:FastifyRequest)=>(req.headers.authorization??"").replace(/^Bearer /,"");
 const csrf=(req:FastifyRequest)=>validateCookieCsrf(req,c);
 const deliver=(reply:any,issued:IssuedSession)=>{const csrfToken=random();reply.header("Set-Cookie",[cookie("dfm_access",issued.accessToken,900),cookie("dfm_refresh",issued.refreshToken,2592000),cookie("dfm_csrf",csrfToken,2592000)]);return {userId:issued.userId,accessExpiresAt:issued.accessExpiresAt,csrfToken};};
 app.get("/v1/auth/status",()=>({enabled,mode:c.APP_MODE}));
 app.get("/v1/auth/csrf",(req)=>({csrfToken:cookies(req).dfm_csrf??""}));
 app.post("/v1/auth/link",async(req,reply)=>{if(!flow)return reply.code(503).send({error:"OIDC_NOT_CONFIGURED"});csrf(req);const current=await sessions.authenticate(cookies(req).dfm_access??"");const begun=await flow.begin();await store.transact(s=>{((s as any).identityLinkFlows??={})[hash(begun.state)]={sessionId:current.sessionId,accessDigest:hash(cookies(req).dfm_access!),expires:Date.now()+600000};});reply.header("Set-Cookie",cookie("dfm_binding",begun.browserBinding,600));return {authorizationUrl:begun.authorizationUrl};});
 app.get("/v1/auth/login",async(_req,reply)=>{if(!flow)return reply.code(503).send({error:"OIDC_NOT_CONFIGURED"});const begun=await flow.begin();reply.header("Set-Cookie",cookie("dfm_binding",begun.browserBinding,600));return {authorizationUrl:begun.authorizationUrl};});
 app.get("/v1/auth/callback",async(req,reply)=>{
  if(!flow)return reply.code(503).send({error:"OIDC_NOT_CONFIGURED"});
  const query=z.object({state:z.string(),code:z.string()}).parse(req.query);
  try {const identity=await flow.complete(query.state,query.code,cookies(req).dfm_binding??"");const linked=await store.transact(s=>{const rows=(s as any).identityLinkFlows;const row=rows?.[hash(query.state)];if(row)delete rows[hash(query.state)];return row;});if(linked){const access=cookies(req).dfm_access??"";if(linked.expires<=Date.now()||linked.accessDigest!==hash(access))throw new Error("LINK_INVALID");await sessions.link(access,identity);}else deliver(reply,await sessions.issue(identity));return reply.redirect("/account/");}catch{return reply.code(401).send({error:"OIDC_LOGIN_FAILED"});}
 });
 app.get("/v1/auth/me",async(req,reply)=>{try{const identity=await sessions.authenticate(bearer(req)||cookies(req).dfm_access||"");return {user:await store.transact(s=>s.users[identity.userId]),csrfToken:cookies(req).dfm_csrf};}catch{return reply.code(401).send({error:"UNAUTHENTICATED"});}});
 // Web game receives only short-lived access in memory; refresh remains HttpOnly.
 app.post("/v1/auth/access",async(req,reply)=>{csrf(req);const access=cookies(req).dfm_access??"";try{const identity=await sessions.authenticate(access);return {accessToken:access,userId:identity.userId};}catch{const issued=await sessions.refresh(cookies(req).dfm_refresh??"");deliver(reply,issued);return {accessToken:issued.accessToken,userId:issued.userId};}});
 app.get("/v1/auth/runs",async(req)=>{const identity=await sessions.authenticate(bearer(req)||cookies(req).dfm_access||"");return {runs:await store.transact(s=>Object.values(s.runs).filter(r=>r.userId===identity.userId).map(r=>({id:r.id,day:r.day,revision:r.revision})))};});
 app.post("/v1/auth/refresh",async(req,reply)=>{try{if(!req.headers.authorization){csrf(req);return deliver(reply,await sessions.refresh(cookies(req).dfm_refresh??""));}const body=z.object({refreshToken:z.string()}).parse(req.body);return await sessions.refresh(body.refreshToken);}catch{return reply.code(401).send({error:"SESSION_INVALID"});}});
 app.post("/v1/auth/logout",async(req,reply)=>{if(!req.headers.authorization)csrf(req);await sessions.logout(bearer(req)||cookies(req).dfm_access||"");reply.header("Set-Cookie",[cookie("dfm_access","",0),cookie("dfm_refresh","",0),cookie("dfm_csrf","",0)]);return {ok:true};});
 // Handoff is hashed at rest, bound to a desktop-generated proof and consumed atomically.
 app.post("/v1/auth/handoff",async(req)=>{csrf(req);const current=await sessions.authenticate(cookies(req).dfm_access??"");const {challenge}=z.object({challenge:z.string().regex(/^[a-f0-9]{64}$/)}).parse(req.body);const code=random();await store.transact(s=>{const state=s as any;const rows=state.desktopHandoffs??={};for(const [key,row]of Object.entries(rows) as any)if(row.expires<=Date.now())delete rows[key];rows[hash(code)]={userId:current.userId,sessionId:current.sessionId,challenge,expires:Date.now()+60000};});return {code,expiresIn:60};});
 app.post("/v1/auth/exchange",async(req,reply)=>{const {code,proof}=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),proof:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(req.body);try{const user=await store.transact(s=>{const row=(s as any).desktopHandoffs?.[hash(code)];if(!row||row.expires<=Date.now()||row.challenge!==hash(proof))throw new Error("HANDOFF_INVALID");sessions.assertActive(s,row.sessionId);delete(s as any).desktopHandoffs[hash(code)];return {userId:row.userId as string,sessionId:row.sessionId as string};});return await sessions.issueForUser(user.userId,user.sessionId);}catch{return reply.code(401).send({error:"HANDOFF_INVALID"});}});
}

