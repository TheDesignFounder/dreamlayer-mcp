import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {ManagedClient,managedBalance} from '../dist/client.js';

const quote={price_version:'sprite-base-frame-20261017-v1',frame_count:12,background:'keep',credits:'2.9334',reference_usd:'0.44',reference_credit_cents:15,binding:false};
async function fixture(body, run, status=200) {
 const requests=[];
 const server=createServer((req,res)=>{requests.push(req.method+' '+req.url);res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try { await run(new ManagedClient('fixture',`http://127.0.0.1:${server.address().port}`),requests); }
 finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
test('sprite estimate is a free account-bound read and preserves four decimal credits',async()=>{
 await fixture(quote,async(client,requests)=>{
  assert.deepEqual(await client.getSpritePrice(12,'keep'),quote);
  assert.deepEqual(requests,['GET /v1/sprite-pricing?frame_count=12&background=keep']);
 });
});
for(const patch of [{binding:true},{price_version:'unknown'},{frame_count:7},{background:'remove'},{credits:'NaN'},{credits:'0'},{credits:'101'},{credits:'2.93345'},{credits:2.9334},{reference_credit_cents:'15'},{reference_credit_cents:17},{reference_usd:'.44'},{private_value:'do-not-expose'}]) {
 test('invalid estimate fails closed: '+JSON.stringify(patch),async()=>{
  await fixture({...quote,...patch},async client=>{await assert.rejects(client.getSpritePrice(12,'keep'),/Invalid DreamLayer sprite estimate response/);});
 });
}
test('missing estimate does not fall back to historical local pricing',async()=>{
 await fixture({error:{reason:'not_found',message:'Unavailable',retryable:false}},async(client,requests)=>{
  await assert.rejects(client.getSpritePrice(12,'keep'));assert.equal(requests.length,1);
 },404);
});
test('invalid estimate arguments make no request',async()=>{
 await fixture(quote,async(client,requests)=>{
  for(const args of [[6,'keep'],[101,'keep'],['12','keep'],[12,'transparent']])await assert.rejects(client.getSpritePrice(...args));
  assert.equal(requests.length,0);
 });
});
for(const rate of ['0.10','0.15']) {
 test('large current balance preserves exact decimal representation at '+rate,()=>{
  const value={promotional:0,purchased:65536.0014,available:65536.0014,credit_usd:rate};
  assert.deepEqual(managedBalance(value),value);
  assert.throws(()=>managedBalance({...value,purchased:65536.00141,available:65536.00141}));
  assert.throws(()=>managedBalance({...value,purchased:1e12,available:1e12}));
 });
 test('current balance preserves four decimal precision at '+rate,()=>{
  const value={promotional:0.0001,purchased:2.9333,available:2.9334,credit_usd:rate};
  assert.deepEqual(managedBalance(value),value);
  assert.throws(()=>managedBalance({...value,available:2.93341}));
  assert.throws(()=>managedBalance({...value,available:2.9332}));
 });
}
test('legacy balance remains accepted without relaxing closed fields or types',()=>{
 const value={promotional:0,purchased:5.8,available:5.8,credit_usd:'0.17'};
 assert.deepEqual(managedBalance(value),value);
 assert.throws(()=>managedBalance({...value,credit_usd:0.17}));
 assert.throws(()=>managedBalance({...value,private_value:'hidden'}));
 assert.throws(()=>managedBalance({...value,purchased:5.81,available:5.81}));
});
