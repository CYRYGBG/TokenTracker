import { act,renderHook,waitFor } from '@testing-library/react';
import { beforeEach,it,expect,vi } from 'vitest';
import { useForkReport } from './use-fork-report';
import { forkApi } from '../lib/fork-api';
vi.mock('../lib/fork-api',()=>({forkApi:vi.fn()}));
const period={from:'2026-10-01',to:'2026-10-02',previousFrom:'2026-09-01',previousTo:'2026-09-02',days:2,previousDays:2};
beforeEach(()=>{ forkApi.mockReset(); });
it('scopes every read to all devices and the selected timezone',async()=>{
 forkApi.mockResolvedValue({totals:{total_tokens:0}});
 const {result}=renderHook(()=>useForkReport(period,'Asia/Shanghai',0));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(forkApi).toHaveBeenCalledTimes(6);
 for(const [path] of forkApi.mock.calls){const params=new URL(path,'http://localhost').searchParams;expect(params.get('device_id')).toBe('all');expect(params.get('tz')).toBe('Asia/Shanghai');}
 expect(result.current.data.days).toHaveLength(2);
});
it('refetches when identical current dates have a different comparison interval and ignores old results',async()=>{
 const resolve=[];forkApi.mockImplementation(()=>new Promise(r=>resolve.push(r)));
 const {result,rerender}=renderHook(({p})=>useForkReport(p,'UTC',0),{initialProps:{p:period}});
 forkApi.mockResolvedValue({totals:{total_tokens:0}});
 rerender({p:{...period,previousFrom:'2026-09-24',previousTo:'2026-09-25'}});
 await waitFor(()=>expect(result.current.loading).toBe(false));
 await act(async()=>resolve.forEach(r=>r({totals:{total_tokens:999}})));
 expect(result.current.data.tokens).toBe(0);
 expect(result.current.data.previousFrom).toBe('2026-09-24');
});
it('clears data instead of showing a successful zero report after failure',async()=>{
 forkApi.mockRejectedValue(new Error('offline'));
 const {result}=renderHook(()=>useForkReport(period,'UTC',0));
 await waitFor(()=>expect(result.current.loading).toBe(false));
 expect(result.current.data).toBeNull();expect(result.current.error).toBe('offline');
});
