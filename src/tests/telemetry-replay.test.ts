import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app';
import { TelemetryService } from '../services/telemetry-service';
import { TwinStore } from '../domain/store';

interface Sample { assetId:string; metric:string; value:number; unit:string; observedAt:number; quality:'good' }
interface ReplayEvent { timestamp:number; sequence:number; payload:{value:number} }

const sample=(observedAt:number,value:number,assetId='pump-1'):Sample=>({assetId,metric:'temperature',value,unit:'C',observedAt,quality:'good'});

async function ingest(app:ReturnType<typeof buildApp>,samples:Sample[]){
  for(const payload of samples){
    const res=await app.inject({method:'POST',url:'/telemetry',payload});
    assert.equal(res.statusCode,200,`ingest failed: ${res.body}`);
  }
}

const replay=(app:ReturnType<typeof buildApp>,query:string)=>app.inject({method:'GET',url:`/telemetry/replay${query?`?${query}`:''}`});
const eventsOf=(body:string):ReplayEvent[]=>JSON.parse(body);
const timestampsOf=(body:string)=>eventsOf(body).map(e=>e.timestamp);
const valuesOf=(body:string)=>eventsOf(body).map(e=>e.payload.value);

test('closed interval: events exactly at from and to are included',async()=>{
  const app=buildApp();
  await ingest(app,[sample(1000,10),sample(1500,15),sample(2000,20)]);
  const res=await replay(app,'from=1000&to=2000');
  assert.equal(res.statusCode,200);
  assert.deepEqual(timestampsOf(res.body),[1000,1500,2000]);
});

test('closed interval: from equal to to returns the exact instant only',async()=>{
  const app=buildApp();
  await ingest(app,[sample(999,9),sample(1000,10),sample(1001,11)]);
  const res=await replay(app,'from=1000&to=1000');
  assert.equal(res.statusCode,200);
  assert.deepEqual(timestampsOf(res.body),[1000]);
});

test('adjacent milliseconds: window is exact and never expanded',async()=>{
  const app=buildApp();
  await ingest(app,[sample(1696118400000,1),sample(1696118400001,2),sample(1696118400002,3)]);
  const single=await replay(app,'from=1696118400001&to=1696118400001');
  assert.equal(single.statusCode,200);
  assert.deepEqual(valuesOf(single.body),[2]);
  const pair=await replay(app,'from=1696118400000&to=1696118400001');
  assert.equal(pair.statusCode,200);
  assert.deepEqual(valuesOf(pair.body),[1,2]);
});

test('cross-second window: out-of-order writes replay in business time order',async()=>{
  const app=buildApp();
  await ingest(app,[sample(1696118400001,3),sample(1696118399999,1),sample(1696118400000,2)]);
  const res=await replay(app,'from=1696118399998&to=1696118400002');
  assert.equal(res.statusCode,200);
  assert.deepEqual(timestampsOf(res.body),[1696118399999,1696118400000,1696118400001]);
});

test('same-timestamp out-of-order writes keep a deterministic insertion order',async()=>{
  const app=buildApp();
  await ingest(app,[sample(2000,1),sample(1000,2),sample(2000,3),sample(1000,4)]);
  const res=await replay(app,'from=1000&to=2000');
  assert.equal(res.statusCode,200);
  const events=eventsOf(res.body);
  assert.deepEqual(events.map(e=>[e.timestamp,e.payload.value]),[[1000,2],[1000,4],[2000,1],[2000,3]]);
  const sequencesInvariant=events.every((e,i)=>i===0||(e.timestamp>events[i-1].timestamp||(e.timestamp===events[i-1].timestamp&&e.sequence>events[i-1].sequence)));
  assert.ok(sequencesInvariant,'events must be ordered by business time, then insertion sequence');
  const again=await replay(app,'from=1000&to=2000');
  assert.deepEqual(eventsOf(again.body),events);
});

test('repeated replay returns identical results and does not mutate stored events',async()=>{
  const app=buildApp();
  await ingest(app,[sample(3000,3),sample(1000,1),sample(2000,2)]);
  const first=await replay(app,'from=1000&to=3000');
  const second=await replay(app,'from=1000&to=3000');
  assert.equal(first.statusCode,200);
  assert.deepEqual(eventsOf(second.body),eventsOf(first.body));
  await ingest(app,[sample(4000,4)]);
  const third=await replay(app,'from=1000&to=3000');
  assert.deepEqual(eventsOf(third.body),eventsOf(first.body));
  const widened=await replay(app,'from=1000&to=4000');
  assert.deepEqual(timestampsOf(widened.body),[1000,2000,3000,4000]);
});

test('events outside the closed interval are excluded',async()=>{
  const app=buildApp();
  await ingest(app,[sample(999,1),sample(1000,2),sample(2000,3),sample(2001,4)]);
  const res=await replay(app,'from=1000&to=2000');
  assert.equal(res.statusCode,200);
  assert.deepEqual(valuesOf(res.body),[2,3]);
});

test('reversed range returns a compatible 400 error',async()=>{
  const app=buildApp();
  const res=await replay(app,'from=2000&to=1000');
  assert.equal(res.statusCode,400);
  const body=JSON.parse(res.body);
  assert.equal(body.code,'INVALID_RANGE');
  assert.equal(typeof body.message,'string');
});

test('malformed bounds return a compatible 400 error',async()=>{
  const app=buildApp();
  for(const query of ['from=abc&to=2000','from=1000&to=soon','from=&to=2000','from=1e999&to=2000']){
    const res=await replay(app,query);
    assert.equal(res.statusCode,400,query);
    const body=JSON.parse(res.body);
    assert.equal(body.code,'INVALID_PARAMETER',query);
    assert.equal(typeof body.message,'string');
  }
});

test('missing bounds return a compatible 400 error',async()=>{
  const app=buildApp();
  for(const query of ['to=2000','from=1000','']){
    const res=await replay(app,query);
    assert.equal(res.statusCode,400,query||'(no query)');
    const body=JSON.parse(res.body);
    assert.equal(body.code,'MISSING_PARAMETER',query);
    assert.equal(typeof body.message,'string');
  }
});

test('service guards the range invariant for direct callers',()=>{
  const service=new TelemetryService(new TwinStore());
  const isInvalidRange=(e:unknown)=>e instanceof Error&&(e as {code?:string}).code==='INVALID_RANGE';
  assert.throws(()=>service.replay(10,1),isInvalidRange);
  assert.throws(()=>service.replay(Number.NaN,1),isInvalidRange);
});
