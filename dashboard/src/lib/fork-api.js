import {
  clearLocalApiAuthToken,
  getLocalApiAuthHeaders,
} from "./local-api-auth";
import { FORK_SYNC_CHANGED_EVENT } from "./fork-sync-status";
export async function forkApi(
  path,
  { method = "GET", body } = {},
  retry = true,
) {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      ...(await getLocalApiAuthHeaders()),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401 && retry) {
    clearLocalApiAuthToken();
    return forkApi(path, { method, body }, false);
  }
  const data = await response.json();
  if (path === "/api/webdav/sync-now")
    window.dispatchEvent(new Event(FORK_SYNC_CHANGED_EVENT));
  if (!response.ok || data.ok === false) {
    const error = new Error(
      typeof data.error === "string"
        ? data.error
        : data.code || `HTTP ${response.status}`,
    );
    Object.assign(error, {
      code: data.code,
      status: data.status || data.error?.status,
      timeout_ms: data.error?.timeout_ms,
    });
    throw error;
  }
  return data;
}
