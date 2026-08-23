import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ASSET_IMPORT_SCRIPT, importChatGptAsset, normalizeAsset, normalizeDestination, isTrustedOpenAiFileHost } from '../src/asset-tools.mjs';

assert.equal(normalizeDestination('public/blog/cover.png'),'public/blog/cover.png');
assert.throws(()=>normalizeDestination('../escape.png'),/inside/);
assert.throws(()=>normalizeDestination('/tmp/escape.png'),/inside/);
assert.equal(isTrustedOpenAiFileHost('files.oaiusercontent.com'),true);
assert.equal(isTrustedOpenAiFileHost('evil.example'),false);
assert.throws(()=>normalizeAsset({download_url:'http://files.oaiusercontent.com/a',file_id:'f'}),/HTTPS/);
assert.throws(()=>normalizeAsset({download_url:'https://example.com/a',file_id:'f'}),/approved/);
assert.equal(normalizeAsset({download_url:'https://files.oaiusercontent.com/a?x=1',file_id:'file_1',mime_type:'image/png'}).fileId,'file_1');

let authorityTouched=false;
await assert.rejects(
  importChatGptAsset({
    authorityExecutor:{resolveAuthority:async()=>{authorityTouched=true;throw new Error('must not resolve');},exec:async()=>{authorityTouched=true;throw new Error('must not exec');}},
    asset:{download_url:'https://files.oaiusercontent.com/a',file_id:'file_big',mime_type:'image/png',size:2048},
    destination:'public/big.png',cwd:process.cwd(),maxBytes:1024,
  }),
  (error)=>error?.code==='ASSET_TOO_LARGE'
);
assert.equal(authorityTouched,false,'declared oversize assets must fail before authority/network work');

const temp=await mkdtemp(path.join(os.tmpdir(),'rootbound-asset-test-'));
let data=Buffer.from('rootbound asset test');
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'image/png','content-length':String(data.length)});res.end(data);});
await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
async function run(cfg){
  const payload=Buffer.from(JSON.stringify(cfg)).toString('base64');
  return await new Promise((resolve)=>{
    const child=spawn(process.execPath,['-e',ASSET_IMPORT_SCRIPT,payload],{cwd:temp});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
try{
  let out=await run({downloadUrl:`http://127.0.0.1:${port}/asset`,destination:'public/a.png',overwrite:false,maxBytes:1024,expectedMimeType:'image/png'});
  assert.equal(out.code,0,out.stderr);let parsed=JSON.parse(out.stdout);assert.equal(parsed.bytes,data.length);assert.equal(await readFile(path.join(temp,'public/a.png'),'utf8'),data.toString());
  out=await run({downloadUrl:`http://127.0.0.1:${port}/asset`,destination:'public/a.png',overwrite:false,maxBytes:1024,expectedMimeType:'image/png'});assert.equal(out.code,23);
  data=Buffer.from('rootbound replacement asset');
  out=await run({downloadUrl:`http://127.0.0.1:${port}/asset`,destination:'public/a.png',overwrite:true,maxBytes:1024,expectedMimeType:'image/png'});
  assert.equal(out.code,0,out.stderr);parsed=JSON.parse(out.stdout);assert.equal(parsed.overwritten,true);assert.equal(await readFile(path.join(temp,'public/a.png'),'utf8'),data.toString());
  out=await run({downloadUrl:`http://127.0.0.1:${port}/asset`,destination:'public/b.png',overwrite:false,maxBytes:2,expectedMimeType:'image/png'});assert.equal(out.code,22);
  out=await run({downloadUrl:`http://127.0.0.1:${port}/asset`,destination:'public/c.png',overwrite:false,maxBytes:1024,expectedMimeType:'image/jpeg'});assert.equal(out.code,25);
} finally { server.close(); await rm(temp,{recursive:true,force:true}); }
console.log('asset-tools core tests: ok');
