import { newId } from '../core/id'; import { assertOrThrow } from '../core/errors'; import { TwinStore } from '../domain/store'; import { DomainEvent, Telemetry } from '../domain/types';
export class TelemetryService {
 constructor(private store:TwinStore){}
 ingest(input:Telemetry){ this.store.telemetry.push({...input}); const event:DomainEvent={id:newId('evt'),type:'telemetry',assetId:input.assetId,timestamp:input.observedAt,sequence:this.store.events.length+1,payload:{metric:input.metric,value:input.value,quality:input.quality}}; this.store.events.push(event); return event; }
 history(assetId:string,metric?:string){return this.store.telemetry.filter(t=>t.assetId===assetId&&(!metric||t.metric===metric)).sort((a,b)=>a.observedAt-b.observedAt)}
 // Closed interval [from, to]: events with timestamp === from or === to are included, nothing outside is ever mixed in.
 // Business replay order is (timestamp, sequence) so out-of-order writes and same-timestamp events replay deterministically.
 replay(from:number,to:number){
  assertOrThrow(Number.isFinite(from)&&Number.isFinite(to),'INVALID_TIME_RANGE','from and to must be finite timestamps');
  assertOrThrow(from<=to,'INVALID_TIME_RANGE',`from (${from}) must be less than or equal to to (${to})`);
  return this.store.events.filter(e=>e.timestamp>=from&&e.timestamp<=to).sort((a,b)=>a.timestamp-b.timestamp||a.sequence-b.sequence)
 }
}
