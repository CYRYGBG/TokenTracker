// Official backend disabled for this personal fork.
export const INSFORGE_INSTANCE_CHANGED_EVENT='tt.disabledInstance';
export function getInsforgeConfiguration(){return {baseUrl:'',anonKey:'',errorCode:null,source:'runtime' as const};}
export function getInsforgeConfigurationError(){return null;}
export function getInsforgeRemoteUrl(){return '';}
export function getInsforgeAnonKey(){return '';}
export function isCloudInsforgeConfigured(){return false;}
export function getInsforgeInstanceFingerprint(){return '';}
export function isOfficialInsforgeInstance(){return false;}
export function getInsforgeConnectionHost(){return null;}
export function resetInsforgeClientForInstanceChange(){}
export function shouldRestoreInsforgeSession(){return false;}
export function allowInsforgeSessionRestore(){}
export function isCurrentInsforgeClient(_client:unknown){return false;}
export function getOrCreateInsforgeClient():any{return null;}

declare global { interface Window { __TOKENTRACKER_RUNTIME_CONFIG__?: {baseUrl?:string|null;anonKey?:string|null;dashboardUrl?:string|null;configurationError?:string|null}; } }
