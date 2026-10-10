import { createHash,randomBytes } from "node:crypto";
import type { Store } from "../store.js";
import type { State } from "../model.js";
export interface VerifiedOidcIdentity {issuer:string;subject:string;name:string;nonce:string}
export interface OidcExchange {
 /** Adapter must verify ID-token signature, issuer, audience, expiry and nonce.
  * Returning decoded unverified JWT claims does not implement this interface.
  */
 exchange(input:{code:string;verifier:string;nonce:string;redirectUri:string}):Promise<VerifiedOidcIdentity>;
}
interface FlowState extends State {oidcFlows?:Record<string,{verifier:string;nonce:string;bindingHash:string;expiresAt:number;consumed:boolean}>}
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const random=()=>randomBytes(32).toString("base64url");
export class OidcFlow {
 constructor(private store:Store,private config:{issuer:string;clientId:string;authorizationEndpoint:string;redirectUri:string;allowLoopbackRedirect?:boolean},private adapter:OidcExchange,private clock:()=>number=Date.now){
  for(const field of [config.issuer,config.authorizationEndpoint])if(new URL(field).protocol!=="https:")throw new Error("OIDC_HTTPS_REQUIRED");
  const callback=new URL(config.redirectUri);
  const loopback=config.allowLoopbackRedirect===true&&callback.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(callback.hostname)&&!callback.username&&!callback.password;
  if(callback.protocol!=='https:'&&!loopback)throw new Error('OIDC_HTTPS_REQUIRED');
  if(!config.clientId)throw new Error("OIDC_CLIENT_REQUIRED");
 }
 async begin(){
  const state=random(),browserBinding=random(),verifier=random(),nonce=random();
  await this.store.transact(value=>{
   const flows=((value as FlowState).oidcFlows??={});
   for(const [key,flow]of Object.entries(flows))if(flow.expiresAt<=this.clock())delete flows[key];
   if(Object.keys(flows).length>=10000)throw new Error("OIDC_FLOW_CAPACITY");
   flows[hash(state)]={verifier,nonce,bindingHash:hash(browserBinding),expiresAt:this.clock()+600000,consumed:false};
  });
  const url=new URL(this.config.authorizationEndpoint);
  for(const [key,value]of Object.entries({response_type:"code",client_id:this.config.clientId,redirect_uri:this.config.redirectUri,scope:"openid profile",state,nonce,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")}))url.searchParams.set(key,value);
  // browserBinding must be an HttpOnly secure cookie when attached to web routes.
  return {state,browserBinding,authorizationUrl:url.href};
 }
 async complete(state:string,code:string,browserBinding:string):Promise<VerifiedOidcIdentity>{
  if(!/^[A-Za-z0-9_-]{43}$/.test(state)||!code||code.length>4096)throw new Error("OIDC_FLOW_INVALID");
  const flow=await this.store.transact(value=>{
   const found=(value as FlowState).oidcFlows?.[hash(state)];
   if(!found||found.consumed||found.expiresAt<=this.clock()||found.bindingHash!==hash(browserBinding))throw new Error("OIDC_FLOW_INVALID");
   found.consumed=true;return {...found};
  });
  // Network outside transaction. A failed exchange needs a new flow; never reuse state.
  const identity=await this.adapter.exchange({code,verifier:flow.verifier,nonce:flow.nonce,redirectUri:this.config.redirectUri});
  if(identity.issuer!==this.config.issuer||identity.nonce!==flow.nonce||!identity.subject)throw new Error("OIDC_IDENTITY_INVALID");
  return identity;
 }
}
