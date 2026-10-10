import type { DialogueProvider } from '../provider.js';
import type { PromptMessage } from '../prompt.js';
export class ProviderUnavailable extends Error {
 constructor(readonly reason:'PROVIDER_RATE_LIMITED'|'PROVIDER_UNAVAILABLE',readonly retryAfterSeconds?:number){super(reason);}
}
export class OpenAICompatibleProvider implements DialogueProvider {
 readonly modelId:string;
 constructor(private options:{baseUrl:string;apiKey:string;model:string;fetch?:typeof fetch}) {this.modelId=options.model;if(!options.apiKey || !options.model || !options.baseUrl) throw new Error('GENERATION_UNAVAILABLE');}
 async complete(messages:PromptMessage[],signal:AbortSignal):Promise<unknown> {
  const response=await (this.options.fetch??fetch)(this.options.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.options.model,messages,response_format:{type:'json_object'},temperature:0.2,max_tokens:1600,...(this.options.model.startsWith('cx/') ? {reasoning_effort:'low'} : {}),...(new URL(this.options.baseUrl).hostname === "openrouter.ai" ? {provider:{require_parameters:true},reasoning:{exclude:true}} : {})}),signal});
  if(!response.ok){const value=Number(response.headers.get('retry-after'));throw new ProviderUnavailable(response.status===429?'PROVIDER_RATE_LIMITED':'PROVIDER_UNAVAILABLE',Number.isFinite(value)&&value>0?Math.min(Math.ceil(value),3600):undefined);}
  const body=await response.text();if(body.length>100000) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  const data=JSON.parse(body);return JSON.parse(data.choices?.[0]?.message?.content??'');
 }
}
