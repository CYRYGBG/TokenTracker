import React from 'react';
import {render,screen,waitFor,act} from '@testing-library/react';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {ForkDeviceUsageCard} from './ForkDeviceUsageCard';
import {LOCAL_USAGE_CHANGED_EVENT} from '../lib/local-usage-transfer';
const mock=vi.hoisted(()=>({api:vi.fn(),card:vi.fn()}));
vi.mock('../lib/fork-api',()=>({forkApi:mock.api}));
vi.mock('../lib/copy',()=>({copy:k=>k}));
vi.mock('../ui/dashboard/components/DeviceUsageCard',()=>({DeviceUsageCard:p=>{mock.card(p);return <div>{p.devices.map(d=><span key={d.id}>{d.device_name}</span>)}</div>;}}));
const data={device:'machine-remote',current_device_id:'machine-local',devices:[{id:'machine-local',device_name:'Mac',total_tokens:100,billable_total_tokens:50},{id:'machine-remote',device_name:'Windows',total_tokens:0,billable_total_tokens:0}],account_sources:[]};
beforeEach(()=>{mock.api.mockReset();mock.card.mockClear();});
afterEach(()=>vi.restoreAllMocks());
it('uses WebDAV devices, preserves idle peers and the shared selected scope',async()=>{
 mock.api.mockResolvedValue(data);
 render(<ForkDeviceUsageCard from="2026-10-01" to="2026-10-31" timeZone="Asia/Shanghai" tzOffsetMinutes={480}/>);
 await screen.findByText('Windows');
 expect(mock.api.mock.calls[0][0]).toContain('tz=Asia%2FShanghai');
 const p=mock.card.mock.calls.at(-1)[0];
 expect(p.showIdleDevices).toBe(true);expect(p.selectedDeviceId).toBe('machine-remote');expect(p.currentDeviceId).toBe('machine-local');
 expect(p.devices[0].total_tokens).toBe(100); // selected zero-billable scope uses total consistently
 await p.onSelectDevice('machine-local');
 expect(mock.api).toHaveBeenCalledWith('/api/fork/view',{method:'PUT',body:{device:'machine-local'}});
});
it('retains the previous device data and reports a failed refresh',async()=>{
 mock.api.mockResolvedValueOnce(data).mockRejectedValue(new Error('offline'));
 render(<ForkDeviceUsageCard from="2026-10-01" to="2026-10-31"/>);
 await screen.findByText('Windows');
 await act(async()=>window.dispatchEvent(new Event(LOCAL_USAGE_CHANGED_EVENT)));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('offline'));
 expect(screen.getByText('Windows')).toBeInTheDocument();
});
