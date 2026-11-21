// Manual cross-device conversation sync (session-sync) frontend helpers.
// Mirrors fork-api/fork-sync-status conventions: structured codes in, localized
// copy out; raw exceptions, credentials, and remote URLs never reach the UI.

import { forkApi } from "./fork-api";
import { copy } from "./copy";

export const SESSION_SYNC_AGENTS = ["codex", "zcode", "antigravity"];

export const SESSION_SYNC_CHANGED_EVENT = "tokentracker:session-sync-changed";

export function agentLabel(agent) {
  if (agent === "codex") return "Codex";
  if (agent === "zcode") return "ZCode";
  if (agent === "antigravity") return "Antigravity";
  return String(agent || "");
}

export async function fetchLocalConversations() {
  return forkApi("/api/session-sync/local");
}

export async function fetchRemoteConversations() {
  return forkApi("/api/session-sync/remote");
}

export async function refreshRemoteConversations() {
  return forkApi("/api/session-sync/remote-refresh", { method: "POST" });
}

export async function uploadConversations(items) {
  return forkApi("/api/session-sync/upload", { method: "POST", body: { items } });
}

export async function importConversations(items) {
  return forkApi("/api/session-sync/import", { method: "POST", body: { items } });
}

export async function deleteRemoteConversation(agent, sessionId) {
  return forkApi("/api/session-sync/delete-remote", { method: "POST", body: { agent, sessionId } });
}

export async function fetchSessionSyncStatus() {
  return forkApi("/api/session-sync/status");
}

// Map backend codes to localized explanations. Codes that need no dedicated
// copy fall through to the generic failure key.
export function describeSessionSyncFailure(code) {
  if (!code) return copy("session_sync.error.generic");
  switch (code) {
    case "BUSY":
      return copy("session_sync.error.busy");
    case "NOT_CONFIGURED":
      return copy("session_sync.error.not_configured");
    case "MISSING_CREDENTIAL":
      return copy("session_sync.error.missing_credential");
    case "WEBDAV_UNAUTHORIZED":
      return copy("session_sync.error.unauthorized");
    case "SESSION_SYNC_SCAN_PENDING":
      return copy("session_sync.error.scan_pending");
    case "SESSION_SYNC_CONFLICT":
      return copy("session_sync.error.conflict");
    case "SESSION_SYNC_LOCAL_EXISTS":
      return copy("session_sync.error.local_exists");
    case "SESSION_SYNC_LOCAL_MISSING":
      return copy("session_sync.error.local_missing");
    case "SESSION_SYNC_LAYOUT_MISMATCH":
      return copy("session_sync.error.layout_mismatch");
    case "SESSION_SYNC_DIGEST_MISMATCH":
      return copy("session_sync.error.digest_mismatch");
    case "SESSION_SYNC_PAYLOAD_TOO_LARGE":
      return copy("session_sync.error.payload_too_large");
    case "SESSION_SYNC_REMOTE_MISSING":
      return copy("session_sync.error.remote_missing");
    case "SESSION_SYNC_REMOTE_INVALID":
      return copy("session_sync.error.remote_invalid");
    default:
      return copy("session_sync.error.generic");
  }
}
