import Foundation

/// A GitHub release as reported by the REST API, or reconstructed from the
/// personal releases page when the API is rate limited. Moved out of
/// `UpdateChecker` so the whole HTTP flow is UI-free (Foundation-only) and can
/// be driven by the CLT harness; the UI flow in `UpdateChecker` keeps using the
/// same struct.
struct GitHubRelease: Decodable {
    let tag_name: String
    let name: String?
    let body: String?
    let html_url: String
    let assets: [Asset]
    let draft: Bool?
    let prerelease: Bool?
    /// SHA-256 hex of the platform DMG taken from the release's SHA256SUMS.txt.
    /// Never decoded from the API; resolved only after the release itself
    /// validates. Both the API and the fallback path must produce it.
    var expectedDigest: String?

    struct Asset: Decodable {
        let name: String
        let browser_download_url: String
        let size: Int
    }

    enum CodingKeys: String, CodingKey {
        case tag_name, name, body, html_url, assets, draft, prerelease
    }

    var tagVersion: String {
        PersonalUpdateChannel.version(tag_name) ?? ""
    }

    var dmgAsset: Asset? {
        guard let name = Self.platformDMGName() else { return nil }
        return assets.first { $0.name == name }
    }

    /// Canonical platform DMG name for the personal channel. Exact match only —
    /// no "any .dmg" fallback, so the API path and the releases-page fallback
    /// always agree on one asset.
    static func platformDMGName() -> String? {
        var sysinfo = utsname()
        uname(&sysinfo)
        let machine = withUnsafePointer(to: &sysinfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        switch machine {
        case "arm64": return "TokenTrackerPersonal-macOS-arm64.dmg"
        case "x86_64": return "TokenTrackerPersonal-macOS-x64.dmg"
        default: return nil
        }
    }
}

/// Pure rate-limit logic for the personal update channel. Semantics match the
/// Windows client (`TokenTrackerWin/UpdateReleaseClient.cs`) and the upstream
/// macOS port (7e65d77): 429 is inherently a rate limit; 403 counts only with
/// evidence (x-ratelimit-remaining: 0, a Retry-After header, or a "rate limit"
/// body). Every other status — and an unmarked 403 — fails as-is.
enum PersonalUpdateRateLimit {

    /// Fixed cooldown when GitHub reports throttling without any usable time.
    static let defaultCooldown: TimeInterval = 60

    /// Case-insensitive header lookup over a plain dictionary snapshot.
    static func headerValue(_ headers: [String: String], _ name: String) -> String? {
        for (key, value) in headers where key.caseInsensitiveCompare(name) == .orderedSame {
            return value.trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    /// Whether this response is throttling with evidence. A plain 403 without
    /// any of the markers is NOT a rate limit and must not trigger a cooldown.
    static func isThrottled(status: Int, headers: [String: String], body: String) -> Bool {
        guard status == 403 || status == 429 else { return false }
        if status == 429 { return true }
        if headerValue(headers, "x-ratelimit-remaining") == "0" { return true }
        if headerValue(headers, "Retry-After") != nil { return true }
        return body.range(of: "rate limit", options: .caseInsensitive) != nil
    }

    /// Whether the anonymous API quota is exhausted for this response.
    static func isQuotaExhausted(headers: [String: String]) -> Bool {
        headerValue(headers, "x-ratelimit-remaining") == "0"
    }

    /// Retry-After as delta-seconds (RFC 7231 allows only a non-negative
    /// integer here; a stricter parse than TimeInterval avoids "0x10"/"inf"
    /// surprises) or as an HTTP-date. Past/negative results yield nil.
    static func parseRetryAfter(_ value: String, now: Date) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty, trimmed.range(of: "^[0-9]+$", options: .regularExpression) != nil,
           let seconds = TimeInterval(trimmed) {
            return now.addingTimeInterval(seconds)
        }
        guard let date = parseHTTPDate(trimmed) else { return nil }
        return date
    }

    /// IMF-fixdate parser ("Sun, 02 Nov 2026 03:04:05 GMT").
    static func parseHTTPDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return formatter.date(from: value)
    }

    /// Cooldown end = longest of Retry-After (delta or HTTP-date) and — when
    /// the quota is exhausted — x-ratelimit-reset. Past timestamps yield nil so
    /// no recovery time is claimed or displayed; callers fall back to
    /// `defaultCooldown` for the skip window while keeping `apiRetryAt` nil.
    static func resolveRetryAt(headers: [String: String], now: Date) -> Date? {
        var retryAt: Date?
        if let retryAfter = headerValue(headers, "Retry-After") {
            retryAt = parseRetryAfter(retryAfter, now: now)
        }
        if isQuotaExhausted(headers: headers),
           let reset = headerValue(headers, "x-ratelimit-reset"),
           reset.range(of: "^[0-9]+$", options: .regularExpression) != nil,
           let epoch = TimeInterval(reset), epoch <= 253_402_300_799 {
            let resetAt = Date(timeIntervalSince1970: epoch)
            if retryAt == nil || resetAt > retryAt! {
                retryAt = resetAt
            }
        }
        guard let resolved = retryAt, resolved > now else { return nil }
        return resolved
    }
}

/// Pure parsing for the releases-page fallback. Only
/// `https://github.com/CYRYGBG/TokenTracker/releases` content (listing page or
/// its atom feed) and that repo's `expanded_assets` fragments may feed these
/// parsers; the repo path is pinned inside every pattern so foreign-repo tag
/// mentions in a page body cannot inject a version.
enum PersonalReleasePageParser {

    /// All personal-vX.Y.Z stable tags referenced under
    /// `<repo>/releases/tag/…` in a releases listing page (HTML) or atom feed.
    /// The trailing negative lookahead rejects longer tags such as
    /// `personal-v1.6.0-beta.1` and `personal-v1.5.0.1` from matching as the
    /// stable prefix; `PersonalUpdateChannel.version` re-validates anyway.
    static func personalTags(inPageBody body: String, repository: String) -> [String] {
        let repo = NSRegularExpression.escapedPattern(for: repository)
        let pattern = repo + "/releases/tag/(personal-v[0-9]+\\.[0-9]+\\.[0-9]+)(?![0-9A-Za-z._-])"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(body.startIndex..., in: body)
        var tags: [String] = []
        for match in regex.matches(in: body, range: range) {
            guard let matchRange = Range(match.range(at: 1), in: body) else { continue }
            let tag = String(body[matchRange])
            if PersonalUpdateChannel.version(tag) != nil, !tags.contains(tag) {
                tags.append(tag)
            }
        }
        return tags
    }

    /// Highest stable personal tag by numeric X.Y.Z comparison (the listing
    /// page/atom feed are newest-first, but a numeric max is order-independent).
    static func latestPersonalTag(from tags: [String]) -> String? {
        var latest: (tag: String, version: String)?
        for tag in tags {
            guard let version = PersonalUpdateChannel.version(tag) else { continue }
            if let current = latest, compareVersions(current.version, version) != .orderedAscending {
                continue
            }
            latest = (tag, version)
        }
        return latest?.tag
    }

    /// Numeric three-part comparison; malformed parts never win.
    static func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".").compactMap { Int($0) }
        let pb = b.split(separator: ".").compactMap { Int($0) }
        let count = max(pa.count, pb.count)
        for i in 0..<count {
            let va = i < pa.count ? pa[i] : 0
            let vb = i < pb.count ? pb[i] : 0
            if va < vb { return .orderedAscending }
            if va > vb { return .orderedDescending }
        }
        return .orderedSame
    }

    /// Download hrefs found in an expanded_assets fragment. Every candidate is
    /// still validated with `PersonalUpdateChannel.assetURL` (exact path, host,
    /// no credentials/query/fragment) before anything trusts it.
    static func assetHrefs(inAssetsFragment body: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: "href=\"([^\"]+)\"") else { return [] }
        let range = NSRange(body.startIndex..., in: body)
        var hrefs: [String] = []
        for match in regex.matches(in: body, range: range) {
            guard let matchRange = Range(match.range(at: 1), in: body) else { continue }
            hrefs.append(String(body[matchRange]))
        }
        return hrefs
    }
}

/// Resolves the latest personal release without UI, downloads or installs.
/// Adapted from the upstream macOS rate-limit fix (7e65d77) to the personal
/// channel — no upstream repo URLs, asset names or update copy are reused:
///
/// - API: `https://api.github.com/repos/CYRYGBG/TokenTracker/releases/latest`,
///   with a strict personal-vX.Y.Z stable tag, exact platform DMG and
///   SHA256SUMS.txt pinned to the same tag (unchanged personal rules).
/// - Cooldown: on a throttled API response the API is skipped until
///   Retry-After/x-ratelimit-reset (fixed 60s when GitHub names no time); a
///   plain 403 without evidence never cools down.
/// - Fallback: the personal releases listing page (or its atom feed) is
///   scraped for the newest personal-vX.Y.Z tag, the tag's expanded_assets
///   fragment pins the platform DMG download URL, and SHA256SUMS.txt is fetched
///   from the same tag — checksum handling is never relaxed on this path.
final class PersonalUpdateReleaseClient {

    static let repository = PersonalUpdateChannel.repository
    private let apiURLString = "https://api.github.com/repos/\(PersonalUpdateChannel.repository)/releases/latest"
    private let listingPageURLString = "https://github.com/\(PersonalUpdateChannel.repository)/releases"
    private let atomFeedURLString = "https://github.com/\(PersonalUpdateChannel.repository)/releases.atom"
    private let checksumsAsset = PersonalUpdateChannel.checksumsAsset

    enum FetchError: LocalizedError {
        case httpStatus(Int)
        case emptyResponse
        case invalidReleasePage
        case assetMissing
        case assetSizeUnavailable
        case checksumUnavailable
        case noRelease

        var errorDescription: String? {
            switch self {
            case .httpStatus(let code): return "Update check failed (HTTP \(code))."
            case .emptyResponse: return "The update server returned an empty response."
            case .invalidReleasePage: return "The releases page did not resolve to a personal release."
            case .assetMissing: return "The release does not contain the platform installer asset."
            case .assetSizeUnavailable: return "The update file size is unavailable."
            case .checksumUnavailable: return "The release has no usable SHA256SUMS entry for the platform installer."
            case .noRelease: return "No stable personal release is available."
            }
        }
    }

    private let session: URLSession
    private let now: () -> Date

    /// When GitHub said the API quota recovers, if it named a time. Nil during
    /// cooldown means "cooling down without a displayed time".
    private(set) var apiRetryAt: Date?
    /// Set for any fetch served (or attempted) via the releases page.
    private(set) var usedFallback = false
    private var apiNotBefore: Date?

    init(session: URLSession = .shared, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
    }

    /// Whether the API is currently cooling down after a throttled attempt.
    var isAPICoolingDown: Bool {
        apiNotBefore.map { $0 > now() } ?? false
    }

    func fetchLatestRelease() async throws -> GitHubRelease {
        usedFallback = false
        if let notBefore = apiNotBefore {
            guard notBefore <= now() else {
                // Cooldown from an earlier throttled attempt: skip the API and
                // re-check the releases page, which sits outside the quota.
                usedFallback = true
                return try await fetchViaReleasesPage()
            }
            apiNotBefore = nil
            apiRetryAt = nil
        }

        var request = URLRequest(url: URL(string: apiURLString)!, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, http) = try await perform(request)

        if http.statusCode == 200 {
            guard !data.isEmpty else { throw FetchError.emptyResponse }
            return try await resolveAPIRelease(data)
        }

        // 403/429 are throttling only with evidence; every other status — and
        // an unmarked 403 — fails as-is instead of masquerading as a rate
        // limit (parity with TokenTrackerWin/UpdateReleaseClient.cs).
        let body = String(data: data, encoding: .utf8) ?? ""
        let headers = Self.headerDictionary(http)
        guard PersonalUpdateRateLimit.isThrottled(status: http.statusCode, headers: headers, body: body) else {
            throw FetchError.httpStatus(http.statusCode)
        }

        let resolved = PersonalUpdateRateLimit.resolveRetryAt(headers: headers, now: now())
        apiRetryAt = resolved
        apiNotBefore = resolved ?? now().addingTimeInterval(PersonalUpdateRateLimit.defaultCooldown)
        usedFallback = true
        return try await fetchViaReleasesPage()
    }

    // MARK: - API path (unchanged personal validation rules)

    private func resolveAPIRelease(_ data: Data) async throws -> GitHubRelease {
        let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
        guard release.draft != true, release.prerelease != true,
              PersonalUpdateChannel.version(release.tag_name) != nil,
              let asset = release.dmgAsset,
              let assetURL = PersonalUpdateChannel.assetURL(asset.browser_download_url, tag: release.tag_name, name: asset.name),
              assetURL.absoluteString == PersonalUpdateChannel.assetURLString(tag: release.tag_name, name: asset.name),
              let checksums = release.assets.first(where: { $0.name == checksumsAsset }),
              let checksumURL = PersonalUpdateChannel.assetURL(checksums.browser_download_url, tag: release.tag_name, name: checksums.name),
              checksumURL.absoluteString == PersonalUpdateChannel.assetURLString(tag: release.tag_name, name: checksums.name)
        else { throw FetchError.noRelease }
        let digest = try await fetchDigest(from: checksumURL, assetName: asset.name)
        var resolved = release
        resolved.expectedDigest = digest
        return resolved
    }

    // MARK: - Releases-page fallback (non-API path, outside the anonymous quota)

    private func fetchViaReleasesPage() async throws -> GitHubRelease {
        let tag = try await resolveLatestPersonalTag()
        guard PersonalUpdateChannel.version(tag) != nil,
              let assetName = GitHubRelease.platformDMGName() else { throw FetchError.noRelease }

        let assetURL = try await resolveAssetURL(tag: tag, assetName: assetName)
        let size = try await headAssetSize(assetURL)
        guard let checksumURLString = PersonalUpdateChannel.assetURLString(tag: tag, name: checksumsAsset),
              let checksumURL = PersonalUpdateChannel.assetURL(checksumURLString, tag: tag, name: checksumsAsset) else {
            throw FetchError.invalidReleasePage
        }
        let digest = try await fetchDigest(from: checksumURL, assetName: assetName)

        return GitHubRelease(
            tag_name: tag,
            name: nil,
            body: nil,
            html_url: "https://github.com/\(Self.repository)/releases/tag/\(tag)",
            assets: [GitHubRelease.Asset(name: assetName, browser_download_url: assetURL.absoluteString, size: size)],
            draft: false,
            prerelease: false,
            expectedDigest: digest
        )
    }

    /// Listing page first; its atom feed as the second permitted source when
    /// the page yields no personal tag. Both responses must land on the
    /// official https github.com repo path with no credentials/query/fragment.
    private func resolveLatestPersonalTag() async throws -> String {
        if let tag = try await personalTagFrom(urlString: listingPageURLString,
                                               accept: "text/html",
                                               allowedPaths: ["/\(Self.repository)/releases", "/\(Self.repository)/releases/"]) {
            return tag
        }
        if let tag = try await personalTagFrom(urlString: atomFeedURLString,
                                               accept: "application/atom+xml",
                                               allowedPaths: ["/\(Self.repository)/releases.atom"]) {
            return tag
        }
        throw FetchError.noRelease
    }

    private func personalTagFrom(urlString: String, accept: String, allowedPaths: [String]) async throws -> String? {
        var request = URLRequest(url: URL(string: urlString)!, timeoutInterval: 15)
        request.setValue(accept, forHTTPHeaderField: "Accept")
        let (data, http) = try await perform(request)
        guard http.statusCode == 200, let body = String(data: data, encoding: .utf8) else {
            throw FetchError.httpStatus(http.statusCode)
        }
        guard let finalURL = http.url,
              Self.isOfficialRepoURL(finalURL),
              allowedPaths.contains(finalURL.path) else { throw FetchError.invalidReleasePage }
        let tags = PersonalReleasePageParser.personalTags(inPageBody: body, repository: Self.repository)
        return PersonalReleasePageParser.latestPersonalTag(from: tags)
    }

    /// The tag page lazy-loads assets from /releases/expanded_assets/<tag>;
    /// that fragment is the only accepted source for the download URL, and the
    /// URL itself must survive `PersonalUpdateChannel.assetURL` (exact
    /// /releases/download/<tag>/<name> path on https github.com, no
    /// credentials/query/fragment, exact asset name).
    private func resolveAssetURL(tag: String, assetName: String) async throws -> URL {
        let fragmentURLString = "https://github.com/\(Self.repository)/releases/expanded_assets/\(tag)"
        guard let fragmentBase = URL(string: fragmentURLString),
              PersonalUpdateChannel.version(tag) != nil,
              Self.isOfficialRepoURL(fragmentBase),
              fragmentBase.path == "/\(Self.repository)/releases/expanded_assets/\(tag)" else {
            throw FetchError.invalidReleasePage
        }
        var request = URLRequest(url: fragmentBase, timeoutInterval: 15)
        request.setValue("text/html", forHTTPHeaderField: "Accept")
        let (data, http) = try await perform(request)
        guard http.statusCode == 200, let body = String(data: data, encoding: .utf8) else {
            throw FetchError.httpStatus(http.statusCode)
        }
        guard let finalURL = http.url,
              finalURL.absoluteString == fragmentURLString else { throw FetchError.invalidReleasePage }
        for href in PersonalReleasePageParser.assetHrefs(inAssetsFragment: body) {
            // Fragment hrefs are path-absolute ("/repo/releases/download/…");
            // only that form may be absolutized, and `assetURL` still enforces
            // the exact https github.com canonical URL afterwards.
            let candidate = href.hasPrefix("/") ? "https://github.com\(href)" : href
            if let url = PersonalUpdateChannel.assetURL(candidate, tag: tag, name: assetName),
               url.absoluteString == PersonalUpdateChannel.assetURLString(tag: tag, name: assetName) {
                return url
            }
        }
        throw FetchError.assetMissing
    }

    private func headAssetSize(_ url: URL) async throws -> Int {
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "HEAD"
        let (_, http) = try await perform(request)
        guard http.statusCode == 200 else { throw FetchError.httpStatus(http.statusCode) }
        let size = Int(http.expectedContentLength)
        guard size > 0 else { throw FetchError.assetSizeUnavailable }
        return size
    }

    /// SHA256SUMS.txt from the same tag, capped like the API path, parsed with
    /// the shared digest parser. A missing/malformed entry fails the update —
    /// the fallback path never relaxes checksum handling.
    private func fetchDigest(from url: URL, assetName: String) async throws -> String {
        let (data, http) = try await perform(URLRequest(url: url, timeoutInterval: 15))
        guard http.statusCode == 200, data.count <= 65536,
              let body = String(data: data, encoding: .utf8),
              let digest = PersonalUpdateChannel.digest(body, name: assetName) else {
            throw FetchError.checksumUnavailable
        }
        return digest
    }

    // MARK: - URL safety

    /// https, github.com, default port, no credentials/query/fragment.
    private static func isOfficialRepoURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "github.com"
            && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
            && url.query == nil && url.fragment == nil
    }

    private static func headerDictionary(_ http: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            headers["\(key)"] = "\(value)"
        }
        return headers
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FetchError.emptyResponse }
        return (data, http)
    }
}
