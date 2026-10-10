import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { State } from "../model.js";

interface StoredSession {
  id:string; familyId:string; userId:string; accessDigest:string; refreshDigest:string;
  accessExpiresAt:number; refreshExpiresAt:number; rotated:boolean; revoked:boolean;
}
interface SessionState extends State {
  authV2?: {identities:Record<string,string>;sessions:Record<string,StoredSession>};
}
export interface IssuedSession {
  sessionId:string;userId:string;accessToken:string;refreshToken:string;
  accessExpiresAt:number;refreshExpiresAt:number;
}
const digest=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
const token=()=>randomBytes(32).toString("base64url");
const initialize=(state:SessionState)=>(state.authV2??={identities:{},sessions:{}});

/** Internal service: issue accepts only an already verified OIDC identity.
 * No public route may forward a client-provided issuer/subject into issue().
 */
export class SessionService {
  constructor(private readonly store:Store,private readonly clock:()=>number=Date.now){}
  async issueForUser(userId:string, originatingSessionId?:string):Promise<IssuedSession>{return this.store.transact(state=>{if(originatingSessionId)this.assertActive(state,originatingSessionId);if(!state.users[userId])throw new Error("SESSION_INVALID");const result=this.create(userId,randomUUID());initialize(state as SessionState).sessions[result.stored.id]=result.stored;return result.issued;});}
  async link(currentToken:string,newIdentity:{issuer:string;subject:string;name:string}):Promise<void>{
    const current=await this.authenticate(currentToken);
    await this.store.transact(state=>{const auth=initialize(state as SessionState);const session=auth.sessions[current.sessionId];if(!session||session.revoked||session.rotated||session.accessExpiresAt<=this.clock())throw new Error("SESSION_INVALID");const key=digest(JSON.stringify([newIdentity.issuer,newIdentity.subject]));const owner=auth.identities[key];if(owner&&owner!==current.userId)throw new Error("IDENTITY_ALREADY_LINKED");auth.identities[key]=current.userId;});
  }
  assertActive(state:State,sessionId:string):void{const session=(state as SessionState).authV2?.sessions[sessionId];if(!session||session.revoked||session.rotated||session.accessExpiresAt<=this.clock())throw new Error("SESSION_INVALID");}
  private create(userId:string,familyId:string,refreshExpiresAt=this.clock()+30*86400000):{stored:StoredSession;issued:IssuedSession}{
    const id=randomUUID(),accessToken=token(),refreshToken=token(),accessExpiresAt=this.clock()+15*60000;
    return {stored:{id,familyId,userId,accessDigest:digest(accessToken),refreshDigest:digest(refreshToken),accessExpiresAt,refreshExpiresAt,rotated:false,revoked:false},
      issued:{sessionId:id,userId,accessToken,refreshToken,accessExpiresAt,refreshExpiresAt}};
  }
  async issue(identity:{issuer:string;subject:string;name:string}):Promise<IssuedSession>{
    if(!identity.issuer||!identity.subject||identity.subject.length>512||identity.issuer.length>2048)throw new Error("IDENTITY_INVALID");
    return this.store.transact(state=>{
      const auth=initialize(state as SessionState);
      const key=digest(JSON.stringify([identity.issuer,identity.subject]));
      let userId=auth.identities[key];
      if(!userId){userId=randomUUID();auth.identities[key]=userId;state.users[userId]={id:userId,name:identity.name.slice(0,100)};}
      if(!state.users[userId])throw new Error("IDENTITY_STATE_INVALID");
      const result=this.create(userId,randomUUID());auth.sessions[result.stored.id]=result.stored;
      return result.issued;
    });
  }
  async authenticate(accessToken:string):Promise<{userId:string;sessionId:string}>{
    if(!/^[A-Za-z0-9_-]{43}$/.test(accessToken))throw new Error("SESSION_INVALID");
    return this.store.transact(state=>{
      const auth=(state as SessionState).authV2;
      const found=Object.values(auth?.sessions??{}).find(s=>s.accessDigest===digest(accessToken));
      if(!found||found.revoked||found.rotated||found.accessExpiresAt<=this.clock()||!state.users[found.userId])throw new Error("SESSION_INVALID");
      return {userId:found.userId,sessionId:found.id};
    });
  }
  async refresh(refreshToken:string):Promise<IssuedSession>{
    if(!/^[A-Za-z0-9_-]{43}$/.test(refreshToken))throw new Error("SESSION_INVALID");
    // Replay revocation must commit before throwing; throwing inside transact
    // would roll back the revocation in PostgreSQL.
    const outcome=await this.store.transact(state=>{
      const auth=(state as SessionState).authV2;
      const found=Object.values(auth?.sessions??{}).find(s=>s.refreshDigest===digest(refreshToken));
      if(!auth||!found||found.revoked||found.refreshExpiresAt<=this.clock()||!state.users[found.userId])return {error:"SESSION_INVALID"} as const;
      if(found.rotated){
        for(const session of Object.values(auth.sessions))if(session.familyId===found.familyId)session.revoked=true;
        return {error:"REFRESH_REPLAY"} as const;
      }
      found.rotated=true;
      const result=this.create(found.userId,found.familyId,found.refreshExpiresAt);
      auth.sessions[result.stored.id]=result.stored;
      return {issued:result.issued};
    });
    if("error"in outcome)throw new Error(outcome.error);
    return outcome.issued;
  }
  async logout(accessToken:string):Promise<void>{
    if(!/^[A-Za-z0-9_-]{43}$/.test(accessToken))throw new Error("SESSION_INVALID");
    await this.store.transact(state=>{
      const auth=(state as SessionState).authV2;
      const found=Object.values(auth?.sessions??{}).find(s=>s.accessDigest===digest(accessToken));
      if(!auth||!found)throw new Error("SESSION_INVALID");
      for(const session of Object.values(auth.sessions))if(session.familyId===found.familyId)session.revoked=true;
    });
  }
}

