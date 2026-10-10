import type {FastifyInstance,FastifyRequest,FastifyReply} from "fastify";
import {z} from "zod";
import {NPC_IDS} from "../domain/contracts.js";
import type {Config} from "../config.js";
import type {Store} from "../store.js";
import type {SessionService} from "../auth/session.js";
import {authCookies} from "../auth/routes.js";
import {DialogueService,type DialogueDependencies} from "../dialogue/service.js";
import {OpenAICompatibleProvider} from "../dialogue/providers/openai-compatible.js";
import {providerSemanticChecker} from "../dialogue/providers/semantic-checker.js";

export type DialogueAuthority=Pick<DialogueDependencies,"context"|"acknowledge">;
const requestSchema=z.object({clientTurnId:z.string().min(1).max(200),expectedRevision:z.number().int().nonnegative(),npcId:z.enum(NPC_IDS),trigger:z.enum(["player_question","arrival","order","payment","object_shown","confrontation","task_return","ending"]),message:z.string().max(1500),beatId:z.string().min(1).max(200),presentedRecordIds:z.array(z.string().min(1)).max(12),heldItemInstanceId:z.string().max(200).optional()}).strict();
export function registerTurnRoutes(app:FastifyInstance,c:Config,store:Store,sessions:SessionService,authority?:DialogueAuthority){
 const ready=Boolean(c.LLM_BASE_URL&&c.LLM_API_KEY&&c.LLM_MODEL);
 const provider=ready?new OpenAICompatibleProvider({baseUrl:c.LLM_BASE_URL!,apiKey:c.LLM_API_KEY!,model:c.LLM_MODEL!}):undefined;
 // A service is session-bound so its single-flight map cannot cross accounts or devices.
 const services=new Map<string,DialogueService>();
 async function service(req:FastifyRequest,reply:FastifyReply):Promise<{instance:DialogueService;userId:string}|undefined>{
  if(!provider){reply.code(503).send({error:"GENERATION_UNAVAILABLE",code:"LLM_NOT_CONFIGURED"});return;}
  if(!authority){reply.code(503).send({error:"GENERATION_UNAVAILABLE",code:"TURN_AUTHORITY_NOT_READY"});return;}
  const token=(req.headers.authorization??"").replace(/^Bearer /,"")||authCookies(req).dfm_access||"";
  const session=await sessions.authenticate(token);
  let instance=services.get(session.sessionId);
  if(!instance){
   // Bound the per-process cache; durable replay remains in Store after eviction.
   if(services.size>=1000)services.delete(services.keys().next().value!);
   instance=new DialogueService(store,{...authority,provider,semanticChecker:providerSemanticChecker(provider),assertSession:state=>sessions.assertActive(state,session.sessionId)});
   services.set(session.sessionId,instance);
  }
  return {instance,userId:session.userId};
 }
 app.post("/v2/runs/:id/turns",async(req,reply)=>{
  const parsed=requestSchema.parse(req.body),result=await service(req,reply);if(!result?.instance)return;
  return result.instance.request(result.userId,(req.params as {id:string}).id,parsed);
 });
 app.post("/v2/runs/:id/turns/:turnId/ack",async(req,reply)=>{
  const body=z.object({expectedRevision:z.number().int().nonnegative()}).strict().parse(req.body),result=await service(req,reply);if(!result?.instance)return;
  const params=req.params as {id:string;turnId:string};return result.instance.acknowledge(result.userId,params.id,params.turnId,body.expectedRevision);
 });
 app.addHook("onClose",async()=>{services.clear();});
}
