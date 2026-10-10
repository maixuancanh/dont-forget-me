import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parse} from 'dotenv';
import net from 'node:net';
const file=new URL('../.env',import.meta.url);
let body=await readFile(file,'utf8');const env=parse(body);
if(env.DATABASE_URL?.trim()){console.log('DATABASE_ALREADY_CONFIGURED; preserved existing settings');process.exit(0);}
await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error('LOCAL_DATABASE_PORT_IN_USE')));server.listen(55450,'127.0.0.1',()=>server.close(resolve));});
const password=env.DFM_DATABASE_PASSWORD||randomBytes(32).toString('hex');
const set=(key,value)=>{const expression=new RegExp(`^${key}=.*$`,'m');body=expression.test(body)?body.replace(expression,`${key}=${value}`):body+`\n${key}=${value}\n`;};
set('DFM_DATABASE_PASSWORD',password);set('DATABASE_URL',`postgresql://dfm_game:${password}@127.0.0.1:55450/dfm_game`);
await writeFile(file,body);
try{execFileSync('docker',['compose','--env-file','.env','-p','dfm-runtime-local','-f','compose.local.yml','up','-d','--wait'],{cwd:new URL('..',import.meta.url),stdio:'pipe',timeout:120000});console.log('LOCAL_GAME_DATABASE_READY (dedicated port 55450; credentials remain in .env)');}
catch{console.error('LOCAL_DATABASE_SETUP_FAILED; inspect Docker status without printing .env');process.exitCode=1;}
