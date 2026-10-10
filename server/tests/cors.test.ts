import {it, expect} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {schema} from '../src/config.js';
import {createApp} from '../src/app.js';
it('allows only the configured game origin and supports authenticated browser preflight', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dfm-cors-'));
 const c=schema.parse({SESSION_SECRET:'test-key-with-at-least-thirty-two-characters',DATA_FILE:join(dir,'state.json'),ALLOWED_ORIGIN:'http://127.0.0.1:8806'});
 const {app}=await createApp(c);
 try {
  const preflight=await app.inject({method:'OPTIONS',url:'/v1/runs/test/events',headers:{origin:'http://127.0.0.1:8806','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});
  expect(preflight.statusCode).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8806');
  expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
  const blocked=await app.inject({method:'OPTIONS',url:'/v1/session',headers:{origin:'https://other.example','access-control-request-method':'POST'}});
  expect(blocked.statusCode).toBe(403);
  expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  const login=await app.inject({method:'POST',url:'/v1/session',headers:{origin:'http://127.0.0.1:8806'},payload:{name:'Browser',accessCode:'browser-test-code'}});
  expect(login.statusCode).toBe(200);
  expect(login.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8806');
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
