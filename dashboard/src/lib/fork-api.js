import {
  clearLocalApiAuthToken,
  getLocalApiAuthHeaders,
} from "./local-api-auth";
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
  if (!response.ok || data.ok === false)
    throw new Error(data.error || data.code || `HTTP ${response.status}`);
  return data;
}
