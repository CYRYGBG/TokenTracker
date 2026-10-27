import React from 'react';
export const CLOUD_SYNC_CHANGE_EVENT='tt.localViewChanged';
export function emitCloudSyncChange(){}
export function AccountViewProvider({children}){return <>{children}</>;}
export function useAccountView(){return {accountView:false,revision:0,localHost:true,resolving:false};}
