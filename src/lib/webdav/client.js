// Minimal read/write WebDAV client for the personal multi-device sync
// (docs/fork/SYNC_DESIGN.md). Built on plain fetch so it runs inside the
// embedded serve process with no extra dependencies.
//
// Design constraints:
// - Only standard WebDAV (RFC 4918) methods: OPTIONS / PROPFIND / MKCOL / GET
//   / PUT / MOVE / DELETE. No versioning, no REPORT, no DeltaV.
// - Never assume an optional behavior: `putAtomic` probes MOVE and falls back
//   to a direct PUT (import-side checksum validation catches truncated files).
// - Every response includes `status` so callers can branch without throwing
//   for expected outcomes (404 on first export, 405 on existing collection).

const DEFAULT_TIMEOUT_MS = 30_000;

function joinUrlPath(...parts) {
  const joined = parts
    .filter((part) => typeof part === "string" && part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/");
  return joined ? `/${joined}` : "/";
}

function normalizeBase(baseUrl) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) {
    throw new Error("webdav baseUrl must start with http:// or https://");
  }
  const parsed = new URL(baseUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) throw new Error('HTTPS required for WebDAV');
  return baseUrl.replace(/\/+$/, "");
}

function encodePath(path) {
  // Encode each segment but keep "/" separators and unreserved chars readable.
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

class WebDavClient {
  constructor({
    baseUrl,
    username,
    password,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (!username || typeof username !== "string") throw new Error("webdav username is required");
    if (!password || typeof password !== "string") throw new Error("webdav password is required");
    this.base = normalizeBase(baseUrl);
    this.authHeader = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.capabilities = null;
  }

  async request(path, { method = "GET", headers = {}, body = null, timeoutMs } = {}) {
    const signal = AbortSignal.timeout(timeoutMs || this.timeoutMs);
    const url = `${this.base}${encodePath(joinUrlPath(path))}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "User-Agent": "TokenTracker-fork-webdav/1",
          ...headers,
        },
        body,
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        const wrapped = new Error(`webdav ${method} ${path} timed out`);
        wrapped.code = "WEBDAV_TIMEOUT";
        throw wrapped;
      }
      const wrapped = new Error(`webdav ${method} ${path} failed: ${error?.message || error}`);
      wrapped.code = "WEBDAV_NETWORK";
      throw wrapped;
    }
    const retryAfterHeader = res.headers?.get?.("retry-after");
    if (!["GET","PROPFIND"].includes(method)) await res.body?.cancel?.().catch(()=>{});
    return {
      status: res.status,
      headers: res.headers,
      retryAfterMs: parseRetryAfterMs(retryAfterHeader),
      res,
    };
  }

  // OPTIONS: returns { davClass, allowed } and caches it on `capabilities`.
  async probeCapabilities(path = "/") {
    const out = await this.request(path, { method: "OPTIONS" });
    if (out.status >= 400) {
      const error = new Error(`webdav OPTIONS returned ${out.status}`);
      error.code = out.status === 401 ? "WEBDAV_UNAUTHORIZED" : "WEBDAV_HTTP";
      error.status = out.status;
      throw error;
    }
    const davHeader = String(out.headers?.get?.("dav") || "");
    const allowHeader = String(out.headers?.get?.("allow") || "")
      .toUpperCase()
      .split(/[\s,]+/)
      .filter(Boolean);
    this.capabilities = {
      davClass: davHeader.split(",").map((c) => c.trim()).filter(Boolean),
      allowed: allowHeader,
      supportsMove: allowHeader.includes("MOVE"),
      supportsDelete: allowHeader.includes("DELETE"),
    };
    return this.capabilities;
  }

  // MKCOL: 201 created; 405 already exists (success for idempotent ensure).
  async mkcol(path) {
    const out = await this.request(path, { method: "MKCOL" });
    if (out.status === 201 || out.status === 405) return { ok: true, created: out.status === 201 };
    return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs };
  }

  async ensureCollection(path) {
    // Build the path segment by segment; parents may already exist.
    const segments = path.split("/").filter(Boolean);
    for (let i = 1; i <= segments.length; i++) {
      const partial = `/${segments.slice(0, i).join("/")}`;
      const result = await this.mkcol(partial);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // PROPFIND depth 1: list a collection's direct children.
  async list(path) {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<d:propfind xmlns:d="DAV:">` +
      `<d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop>` +
      `</d:propfind>`;
    const out = await this.request(path, {
      method: "PROPFIND",
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body,
    });
    if (out.status === 404) return { ok: true, notFound: true, entries: [] };
    if (out.status !== 207) {
      return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs, entries: [] };
    }
    const xml = await out.res.text();
    return { ok: true, notFound: false, entries: parsePropfindEntries(xml, this.base) };
  }

  async get(path) {
    const out = await this.request(path, { method: "GET" });
    if (out.status === 404) return { ok: true, notFound: true, body: null };
    if (out.status !== 200) {
      return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs, body: null };
    }
    return { ok: true, notFound: false, body: await out.res.text() };
  }

  async put(path, content) {
    const out = await this.request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    });
    if (out.status === 200 || out.status === 201 || out.status === 204) return { ok: true };
    return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs };
  }

  async move(from, to) {
    const out = await this.request(from, {
      method: "MOVE",
      headers: { Destination: `${this.base}${encodePath(joinUrlPath(to))}`, Overwrite: "F" },
    });
    if (out.status === 201 || out.status === 204) return { ok: true };
    return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs };
  }

  async delete(path) {
    const out = await this.request(path, { method: "DELETE" });
    if (out.status === 200 || out.status === 204 || out.status === 404) return { ok: true };
    return { ok: false, status: out.status, retryAfterMs: out.retryAfterMs };
  }

  // Atomic-ish publish: upload to `<path>.part`, then MOVE over the final
  // name. Falls back to a direct PUT when MOVE is unsupported — the importer's
  // checksum validation is the safety net for truncated direct uploads.
  async putAtomic(path, content, { useMove = true } = {}) {
    const partPath = `${path}.part`;
    const part = await this.put(partPath, content);
    if (!part.ok) return part;
    if (!useMove) { const direct = await this.put(path, content); await this.delete(partPath); return {...direct, atomic:false}; }
    const moved = await this.move(partPath, path);
    if (moved.ok) return { ok: true, atomic: true };
    if (moved.status === 405 || moved.status === 501 || moved.status === 502) {
      // MOVE unavailable (or destination exists): finish with a direct PUT.
      const direct = await this.put(path, content);
      if (!direct.ok) return direct;
      await this.delete(partPath);
      return { ok: true, atomic: false };
    }
    const error = new Error(`webdav publish failed with MOVE status ${moved.status}`);
    error.code = "WEBDAV_PUBLISH_FAILED";
    error.status = moved.status;
    throw error;
  }
}

function parseRetryAfterMs(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const asDate = Date.parse(trimmed);
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : null;
}

// Minimal multistatus parser: enough for our own listing needs (href +
// resourcetype + contentlength). Uses regex extraction deliberately — a real
// XML parser is not worth a dependency for one fixed shape we control.
function parsePropfindEntries(xml, base) {
  const entries = [];
  const responses = xml.match(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g) || [];
  for (const response of responses) {
    const hrefMatch = response.match(/<(?:\w+:)?href>([\s\S]*?)<\/(?:\w+:)?href>/);
    if (!hrefMatch) continue;
    let href = hrefMatch[1].trim();
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    const isCollection = /<(?:\w+:)?collection\s*\/?\s*>/.test(response);
    const lengthMatch = response.match(/<(?:\w+:)?getcontentlength>(\d+)<\/(?:\w+:)?getcontentlength>/);
    const modifiedMatch = response.match(/<(?:\w+:)?getlastmodified>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/);
    const etagMatch = response.match(/<(?:\w+:)?getetag>([\s\S]*?)<\/(?:\w+:)?getetag>/);
    entries.push({
      href,
      name: hrefName(href, base),
      isCollection,
      contentLength: lengthMatch ? Number(lengthMatch[1]) : null,
      lastModified: modifiedMatch ? modifiedMatch[1].trim() : null,
      etag: etagMatch ? etagMatch[1].trim() : null,
    });
  }
  return entries;
}

function hrefName(href, base) {
  const withoutQuery = href.split("?")[0];
  return withoutQuery.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "/";
}

module.exports = {
  WebDavClient,
  joinUrlPath,
  parseRetryAfterMs,
};
