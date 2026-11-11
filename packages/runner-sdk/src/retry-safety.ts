import type {BrowserContext, Page, Request} from '@playwright/test';
export type RetrySafety = 'READ_ONLY_OBSERVED' | 'WRITE_POSSIBLE' | 'UNKNOWN';
/** No URL/header/body is retained. A closed, fully observed business Context is required. */
export class RetryObservation {
 private writes:boolean;
 private closed=false;
 private pages=new Set<Page>();
 private request=(request:Request)=>this.method(request.method());
 private websocket=()=>{this.writes=true;};
 private page=(page:Page)=>{this.pages.add(page);page.on('websocket',this.websocket);};
 private close=()=>{this.closed=true;};
 constructor(private context:BrowserContext,declaredWrites:boolean){
  this.writes=declaredWrites;
  context.on('request',this.request);context.on('page',this.page);context.on('close',this.close);
  for(const page of context.pages())this.page(page);
 }
 method(method:string){if(!['GET','HEAD','OPTIONS'].includes(method.toUpperCase()))this.writes=true;}
 finish(finalized:boolean):RetrySafety {
  this.context.off('request',this.request);this.context.off('page',this.page);this.context.off('close',this.close);
  for(const page of this.pages)page.off('websocket',this.websocket);
  return this.writes?'WRITE_POSSIBLE':finalized&&this.closed?'READ_ONLY_OBSERVED':'UNKNOWN';
 }
}
