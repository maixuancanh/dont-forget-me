import {it,expect} from 'vitest';
import {config} from '../src/config.js';
it('optional blank provider fields permit development but never production readiness',()=>{
 const env={SESSION_SECRET:'fixture-only-session-secret-over-32-characters',OIDC_AUTHORIZATION_ENDPOINT:'',OIDC_TOKEN_ENDPOINT:'',OIDC_REDIRECT_URI:'',LLM_API_KEY:'',DATABASE_URL:''};
 expect(config(env).OIDC_REDIRECT_URI).toBeUndefined();
 expect(()=>config({...env,APP_MODE:'production'})).toThrow('Production requires');
});
