import { act,renderHook,waitFor } from '@testing-library/react';
import { beforeEach,it,expect,vi } from 'vitest';
import { useForkReport } from './use-fork-report';
import { forkApi } from '../lib/fork-api';
vi.mock('../lib/fork-api',()=>({forkApi:vi.fn()}));
const period={from:'2026-10-01',to:'2026-10-02',previousFrom:'2026-09-01',previousTo:'2026-09-02',days:2,previousDays:2};
const reportPayload=(tokens=0)=>({
 summary:{totals:{total_tokens:tokens,total_cost_usd:'0'}},
 previous:{totals:{total_tokens:tokens,total_cost_usd:'0'}},
 daily:{data:[{day:'2026-10-01',total_tokens:tokens,total_cost_usd:0},{day:'2026-10-02',total_tokens:tokens,total_cost_usd:0}]},
 breakdown:{sources:[]},
 projects:{entries:[]},
 devices:{devices:[],account_sources:[]},
});
beforeEach(()=>{ forkApi.mockReset(); });
it('scopes the report request to all devices and the selected timezone',async()=>{
 forkApi.mockResolvedValue(reportPayload());
 const {result}=renderHook(()=>useForkReport(period,'Asia/Shanghai',0));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(forkApi).toHaveBeenCalledTimes(1);
 const [path]=forkApi.mock.calls[0];
 const params=new URL(path,'http://localhost').searchParams;
 expect(params.get('device_id')).toBe('all');
 expect(params.get('tz')).toBe('Asia/Shanghai');
 expect(params.get('from')).toBe('2026-10-01');
 expect(params.get('to')).toBe('2026-10-02');
 expect(params.get('previous_from')).toBe('2026-09-01');
 expect(params.get('previous_to')).toBe('2026-09-02');
 expect(result.current.data.days).toHaveLength(2);
});
it('refetches when identical current dates have a different comparison interval and ignores old results',async()=>{
 const resolve=[];forkApi.mockImplementation(()=>new Promise(r=>resolve.push(r)));
 const {result,rerender}=renderHook(({p})=>useForkReport(p,'UTC',0),{initialProps:{p:period}});
 forkApi.mockResolvedValue(reportPayload(0));
 rerender({p:{...period,previousFrom:'2026-09-24',previousTo:'2026-09-25'}});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 // The stale first refresh resolves with different data after the fact; the
 // generation guard must keep it from overwriting the newer result.
 await act(async()=>resolve.forEach(r=>r(reportPayload(999))));
 expect(result.current.data.tokens).toBe(0);
 expect(result.current.data.previousFrom).toBe('2026-09-24');
});
it('clears data instead of showing a successful zero report after failure',async()=>{
 forkApi.mockRejectedValue(new Error('offline'));
 const {result}=renderHook(()=>useForkReport(period,'UTC',0));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.data).toBeNull();expect(result.current.error).toBe('offline');
});
