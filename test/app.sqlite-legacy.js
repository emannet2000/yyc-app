import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { createApp } from '../src/server.js';
const password='Test-only-password-24!';
async function listen(app){await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+app.server.address().port;}
async function close(app){await new Promise(r=>{app.server.close(r);app.server.closeAllConnections()});app.store.db.close();}
test('YYC authenticated workflow, access boundaries, concurrency and persistence',async t=>{
 let dir=await mkdtemp(join(tmpdir(),'yyc-test-')),filename=join(dir,'yyc.sqlite'),store=openStore(filename),app=createApp({store}),base=await listen(app);let adminAccount=await store.createUser({role:'admin',name:'Test broker',email:'broker@example.test',password},true);
 const clients={admin:{},store:{},other:{},driver:{}};
 async function request(client,path,{method='GET',data,origin=base,csrf=true}={}){let r=await fetch(base+path,{method,headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{Origin:origin}:{}),...(client.cookie?{Cookie:client.cookie}:{}),...(csrf&&client.csrf?{'X-CSRF-Token':client.csrf}:{})},body:data!==undefined?JSON.stringify(data):undefined});let value=(r.headers.get('content-type')||'').includes('application/json')?await r.json():await r.text();let c=r.headers.get('set-cookie');if(c)client.cookie=c.split(';')[0];if(value.csrf)client.csrf=value.csrf;return {status:r.status,value};}
 async function login(client,em){let r=await request(client,'/api/login',{method:'POST',data:{email:em,password}});assert.equal(r.status,200);return r.value.user;}
 const booking={pickup:'Warehouse A, Calgary',destination:'Store B, Calgary',date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),window:'09:00–12:00',goods:'Boxed supplies',pallets:3,kg:600,type:'Box truck',unloading:'Store has a loading dock',pickupContact:'Warehouse desk',receivingContact:'Store desk',hours:'09:00–17:00',appointment:'TEST-ONLY',notes:'Use dock B'};
 let id,s;
 const state=async client=>(await request(client,'/api/state')).value;
 const shipment=async(client,id)=>(await state(client)).shipments.find(s=>s.id===id);
 async function act(client,id,action,data={}){let v=await shipment(client,id);return request(client,'/api/shipments/'+id+'/actions',{method:'POST',data:{action,version:v?.version||1,...data}});}
 try{
 await t.test('anonymous access, public role restriction and registration',async()=>{
 assert.equal((await request({},'/api/state')).status,401);
 assert.equal((await request({},'/api/register',{method:'POST',data:{name:'No',role:'admin',email:'bad@example.test',password}})).status,400);
 assert.equal((await request({},'/api/register',{method:'POST',data:{name:'Test store',role:'store',email:'store@example.test',password,address:'Store address',phone:'000',contact:'Store contact'}})).status,201);
 assert.equal((await request({},'/api/register',{method:'POST',data:{name:'Other store',role:'store',email:'other@example.test',password,address:'Other address',phone:'000',contact:'Other contact'}})).status,201);
 assert.equal((await request({},'/api/register',{method:'POST',data:{name:'Test driver',role:'driver',email:'driver@example.test',password,phone:'000',truck:'Test truck',plate:'TEST-01',type:'Box truck',kg:3000,pallets:8,area:'Calgary',liftgate:true}})).status,201);
 await login(clients.admin,'broker@example.test');await login(clients.store,'store@example.test');await login(clients.other,'other@example.test');await login(clients.driver,'driver@example.test');
 let hash=store.db.prepare('SELECT password_hash FROM users WHERE id=?').get(adminAccount.id).password_hash;assert(!hash.includes(password));assert.equal((await state(clients.driver)).user.approved,false);
 });
 await t.test('origin, CSRF, validation and ownership guards',async()=>{
 assert.equal((await request(clients.store,'/api/shipments',{method:'POST',data:booking,origin:'https://untrusted.example'})).status,403);
 assert.equal((await request(clients.store,'/api/shipments',{method:'POST',data:booking,csrf:false})).status,403);
 assert.equal((await request(clients.store,'/api/shipments',{method:'POST',data:{...booking,date:'2026-99-99'}})).status,400);
 let r=await request(clients.store,'/api/shipments',{method:'POST',data:booking});assert.equal(r.status,201);s=r.value.shipment;id=s.id;assert.equal(s.status,'Awaiting quote');
 assert.equal((await state(clients.other)).shipments.length,0);
 assert.equal((await request(clients.other,'/api/shipments/'+id+'/actions',{method:'POST',data:{action:'cancel',version:s.version}})).status,404);
 assert.equal((await act(clients.store,id,'quote',{price:450,rate:320})).status,403);
 assert.equal((await request(clients.driver,'/api/shipments',{method:'POST',data:booking})).status,403);
 });
 await t.test('quote acceptance, manual approval and atomic driver acceptance',async()=>{
 let oldVersion=s.version;assert.equal((await act(clients.admin,id,'quote',{price:450,rate:320})).status,200);
 assert.equal((await request(clients.store,'/api/shipments/'+id+'/actions',{method:'POST',data:{action:'acceptQuote',version:oldVersion}})).status,409);
 assert.equal((await act(clients.store,id,'acceptQuote')).status,200);
 let driver=(await state(clients.driver)).user;
 assert.equal((await act(clients.admin,id,'offer',{driverId:driver.id})).status,409);
 assert.equal((await request(clients.store,'/api/drivers/'+driver.id+'/approve',{method:'POST',data:{}})).status,403);
 assert.equal((await request(clients.admin,'/api/drivers/'+driver.id+'/approve',{method:'POST',data:{}})).status,200);
 assert.equal((await act(clients.admin,id,'offer',{driverId:driver.id})).status,200);
 let offered=await shipment(clients.driver,id);assert(!('price' in offered));let customer=await shipment(clients.store,id);assert(!('rate' in customer));
 const responses=await Promise.all([request(clients.driver,'/api/shipments/'+id+'/actions',{method:'POST',data:{action:'acceptJob',version:offered.version}}),request(clients.driver,'/api/shipments/'+id+'/actions',{method:'POST',data:{action:'acceptJob',version:offered.version}})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await shipment(clients.driver,id)).status,'Assigned');
 });
 await t.test('one active job per driver and material-change invalidation',async()=>{
 let r=await request(clients.store,'/api/shipments',{method:'POST',data:{...booking,destination:'Store C, Calgary'}});let id2=r.value.shipment.id;
 await act(clients.admin,id2,'quote',{price:420,rate:300});await act(clients.store,id2,'acceptQuote');let driver=(await state(clients.driver)).user;
 assert.equal((await act(clients.admin,id2,'offer',{driverId:driver.id})).status,409);
 let changed=await act(clients.admin,id2,'change',{destination:'Store D, Calgary',kg:950,pallets:4,reason:'Customer changed cargo'});assert.equal(changed.status,200);assert.equal(changed.value.shipment.status,'Awaiting quote');assert.equal(changed.value.shipment.price,null);assert.equal(changed.value.shipment.quoteVersion,2);assert.equal(changed.value.shipment.quoteArchive[0].price,420);
 assert.equal((await act(clients.store,id2,'acceptQuote')).status,409);
 });
 await t.test('pickup, arrival, exception handling and required delivery evidence',async()=>{
 assert.equal((await act(clients.driver,id,'deliver',{pod:'POD-TEST',recipient:'Receiver'})).status,409);
 assert.equal((await act(clients.driver,id,'arrival')).status,200);assert.equal((await shipment(clients.store,id)).status,'Assigned');
 assert.equal((await act(clients.driver,id,'pickup')).status,200);
 assert.equal((await act(clients.driver,id,'issue',{reason:'Store closed',note:'Receiving team unavailable'})).status,200);
 assert.equal((await act(clients.driver,id,'deliver',{pod:'POD-TEST',recipient:'Receiver'})).status,409);
 assert.equal((await act(clients.driver,id,'resolve',{resolution:'Not allowed'})).status,403);
 assert.equal((await act(clients.admin,id,'resolve',{resolution:'Store contacted; receiving team is now available'})).status,200);
 assert.equal((await act(clients.driver,id,'deliver',{pod:' ',recipient:'Receiver'})).status,400);
 assert.equal((await act(clients.driver,id,'deliver',{pod:'POD-TEST',recipient:'Receiver'})).status,200);
 assert.equal((await shipment(clients.store,id)).pod,'POD-TEST');assert.equal((await shipment(clients.store,id)).status,'Delivered');
 });
 await t.test('eligibility is rechecked on acceptance and historical driver prices stay private',async()=>{
 let revised=(await state(clients.admin)).shipments.find(s=>s.quoteVersion===2),driver=(await state(clients.driver)).user;
 await act(clients.admin,revised.id,'quote',{price:600,rate:400});await act(clients.store,revised.id,'acceptQuote');assert.equal((await act(clients.admin,revised.id,'offer',{driverId:driver.id})).status,200);
 let row=store.truck(driver.id),profile=JSON.parse(row.profile);store.db.prepare('UPDATE trucks SET profile=? WHERE driver_id=?').run(JSON.stringify({...profile,kg:100}),driver.id);
 assert.equal((await act(clients.driver,revised.id,'acceptJob')).status,409);store.db.prepare('UPDATE trucks SET profile=? WHERE driver_id=?').run(JSON.stringify(profile),driver.id);
 assert.equal((await act(clients.driver,revised.id,'acceptJob')).status,200);let view=await shipment(clients.driver,revised.id);assert(!('price' in view));assert(!('price' in view.quoteArchive[0]));assert.equal(view.quoteArchive[0].rate,300);
 });
 await t.test('profile rename keeps ownership; sensitive files are not served',async()=>{
 assert.equal((await request(clients.store,'/api/profile',{method:'PATCH',data:{name:'Renamed test store',address:'New address',contact:'Same receiver',phone:'000'}})).status,200);
 assert.equal((await shipment(clients.store,id)).customer,'Renamed test store');
 assert.equal((await request({},'/src/store.js')).status,404);assert.equal((await request({},'/data/yyc.sqlite')).status,404);assert.equal((await request({},'/')).status,200);assert.equal((await request({},'/demo/')).status,200);
 });
 await t.test('records and sessions survive restart; logout invalidates session',async()=>{
 await close(app);store=openStore(filename);app=createApp({store});base=await listen(app);
 let saved=await shipment(clients.store,id);assert.equal(saved.status,'Delivered');assert.equal(saved.pod,'POD-TEST');assert(saved.history.some(e=>e.text.includes('resolved exception')));
 assert.equal((await request(clients.store,'/api/logout',{method:'POST',data:{}})).status,200);assert.equal((await request(clients.store,'/api/state')).status,401);
 });
 }finally{await close(app);await rm(dir,{recursive:true,force:true});}
});
