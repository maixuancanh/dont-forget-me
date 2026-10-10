import type pg from 'pg';
/** SQL work only. Provider/model calls must finish before entering this helper. */
export async function transaction<T>(pool:pg.Pool, work:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {await client.query('BEGIN'); const result=await work(client); await client.query('COMMIT'); return result;}
  catch(error) {await client.query('ROLLBACK').catch(()=>{}); throw error;}
  finally {client.release();}
}
export class AuthorityError extends Error {
  constructor(public code:string, public statusCode=409) {super(code);}
}
export function assertTestDatabase(url:string):void {
  let parsed:URL; try {parsed=new URL(url);} catch {throw new Error('TEST_DATABASE_URL_REQUIRED');}
  if(!['postgres:','postgresql:'].includes(parsed.protocol) || !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)
    || parsed.pathname!='/dfm_test' || parsed.username!=='dfm_test') throw new Error('REFUSE_NON_TEST_DATABASE');
}
