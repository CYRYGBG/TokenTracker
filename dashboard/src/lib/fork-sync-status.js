import { copy } from "./copy";
export const FORK_SYNC_CHANGED_EVENT = "tokentracker:fork-sync-changed";
// Describe only structured, credential-free facts. Never render raw server
// exception messages, WebDAV URLs, or snapshot paths in persistent notices.
export function describeSyncFailure(failure) {
  if (!failure) return "";
  const code = String(failure.code || "").toUpperCase();
  const seconds =
    Number(failure.timeout_ms) > 0
      ? Math.ceil(failure.timeout_ms / 1000)
      : null;
  let message;
  if (code === "WEBDAV_TIMEOUT")
    message = seconds
      ? copy("fork.sync.timeout_seconds", { seconds })
      : copy("fork.sync.timeout");
  else if (
    code === "WEBDAV_UNAUTHORIZED" ||
    [401, 403].includes(Number(failure.status))
  )
    message = copy("fork.sync.unauthorized");
  else if (Number(failure.status) === 429)
    message = copy("fork.sync.rate_limited");
  else if (code === "WEBDAV_NETWORK") message = copy("fork.sync.network");
  else if (code === "MISSING_CREDENTIAL")
    message = copy("fork.sync.credential");
  else if (code === "INVALID_CONFIG") message = copy("fork.sync.config");
  else if (code === "WEBDAV_INVALID_DOCUMENT" || code === "WEBDAV_PARTIAL")
    message = copy("fork.sync.partial");
  else message = copy("fork.sync.failed");
  const status = Number(failure.status);
  return message + (status >= 400 && status <= 599 ? ` (HTTP ${status})` : "");
}
