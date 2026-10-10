import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
const execute=promisify(execFile);
it('live authority script rejects absent explicit production fixture flags before connecting',async()=>{
 try{await execute(process.execPath,['--import','tsx','scripts/verify-authority-mainnet.ts'],{cwd:process.cwd(),timeout:15000});throw Error('SHOULD_REJECT');}
 catch(error){const output=(error as {stderr?:string}).stderr??'';expect(output).toContain('EXPLICIT_FIXTURE_FLAGS_REQUIRED');expect(output).not.toContain('postgresql://');}
});
it('live fixture script contains no SQL delete/drop and requires pinned synthetic schema prefixes',async()=>{
 const source=await readFile(new URL('../scripts/verify-authority-mainnet.ts',import.meta.url),'utf8');
 expect(source).not.toMatch(/(?:DROP\s+(?:SCHEMA|TABLE)|DELETE\s+FROM|TRUNCATE\s+)/i);
 expect(source).toContain('dfm_authority_proof_src_');expect(source).toContain('dfm_authority_proof_dst_');expect(source).toContain('TARGET_NOT_EMPTY_MANUAL_RESUME_REVIEW_REQUIRED');
});
