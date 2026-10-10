import type pg from 'pg';
export async function tombstoneIds(db: Pick<pg.Pool, 'query'>, userId: string, runId: string): Promise<Set<string>> {
  const result = await db.query('SELECT record_id FROM memory_tombstones WHERE user_id=$1 AND run_id=$2', [userId,runId]);
  return new Set(result.rows.map(r => r.record_id));
}
export async function withoutTombstones<T extends {id:string}>(db: Pick<pg.Pool,'query'>,userId:string,runId:string,records:readonly T[]) {
  const denied=await tombstoneIds(db,userId,runId);
  let changed=true;while(changed){changed=false;for(const item of records){const r=item as T&{sourceIds?:string[];originIds?:string[];supersedesId?:string};if(!denied.has(r.id)&&[...(r.sourceIds??[]),...(r.originIds??[]),...(r.supersedesId?[r.supersedesId]:[])].some(id=>denied.has(id))){denied.add(r.id);changed=true;}}}
  return records.filter(r=>!denied.has(r.id));
}
