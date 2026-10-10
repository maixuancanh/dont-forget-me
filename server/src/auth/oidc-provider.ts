import { createRemoteJWKSet,jwtVerify,customFetch } from "jose";
import type { OidcExchange,VerifiedOidcIdentity } from "./oidc.js";

/** Configured provider endpoints only; no client-controlled token/JWKS URL. */
export class OidcProvider implements OidcExchange {
 private readonly jwks;
 constructor(private config:{issuer:string;clientId:string;clientSecret?:string;tokenEndpoint:string;jwksUri:string},private request:typeof fetch=fetch){
  for(const value of [config.issuer,config.tokenEndpoint,config.jwksUri])if(new URL(value).protocol!=="https:")throw new Error("OIDC_HTTPS_REQUIRED");
  this.jwks=createRemoteJWKSet(new URL(config.jwksUri),{timeoutDuration:5000,[customFetch]:(url,options)=>request(url,{...options,redirect:"error"})});
 }
 async exchange(input:{code:string;verifier:string;nonce:string;redirectUri:string}):Promise<VerifiedOidcIdentity>{
  const form=new URLSearchParams({grant_type:"authorization_code",code:input.code,code_verifier:input.verifier,redirect_uri:input.redirectUri,client_id:this.config.clientId});
  if(this.config.clientSecret)form.set("client_secret",this.config.clientSecret);
  const response=await this.request(this.config.tokenEndpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form,signal:AbortSignal.timeout(10000),redirect:"error"});
  if(!response.ok)throw new Error("OIDC_PROVIDER_UNAVAILABLE");
  const value=await response.json() as {id_token?:unknown};
  if(typeof value.id_token!=="string"||value.id_token.length>32768)throw new Error("OIDC_IDENTITY_INVALID");
  const {payload}=await jwtVerify(value.id_token,this.jwks,{issuer:this.config.issuer,audience:this.config.clientId,algorithms:["RS256","ES256"],requiredClaims:["exp","iat","sub","iss","aud"]});
  if(payload.nonce!==input.nonce||!payload.sub||typeof payload.sub!=="string"||payload.sub.length>512||
   typeof payload.iat!=="number"||payload.iat>Math.floor(Date.now()/1000)+60||
   (Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==this.config.clientId)||
   (payload.azp!==undefined&&payload.azp!==this.config.clientId))throw new Error("OIDC_IDENTITY_INVALID");
  return {issuer:this.config.issuer,subject:payload.sub,nonce:input.nonce,name:typeof payload.name==="string"?payload.name.slice(0,100):"Player"};
 }
}
