import { it,expect } from 'vitest';
import { describeSyncFailure } from './fork-sync-status';
it('explains timeout, HTTP and credential failures without leaking raw exception content',()=>{
 expect(describeSyncFailure({code:'WEBDAV_TIMEOUT',timeout_ms:30000,message:'private path'})).toContain('30 seconds');
 expect(describeSyncFailure({code:'WEBDAV_HTTP',status:429})).toContain('rate limiting');
 expect(describeSyncFailure({code:'WEBDAV_HTTP',status:403})).toContain('rejected access');
 expect(describeSyncFailure({code:'MISSING_CREDENTIAL'})).toContain('app password');
 expect(describeSyncFailure({message:'private path'})).not.toContain('private path');
});
