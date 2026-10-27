// Compatibility context for retained statistical views. No cloud client or auth.
import React from 'react';
const value={enabled:false,signedIn:false,loading:false,user:null,client:null,displayName:'个人版',configurationError:null,getAccessToken:async()=>null,signOut:async()=>{}};
export function InsforgeAuthProvider({children}){return <>{children}</>;}
export function useInsforgeAuth(){return value;}
export async function resolveInsforgeClientAccessToken(){return null;}
