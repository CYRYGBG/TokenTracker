import Foundation
import CryptoKit

enum PersonalUpdateChannel {
    static let repository = "CYRYGBG/TokenTracker"
    static let checksumsAsset = "SHA256SUMS.txt"
    static let bundleIdentifier = "com.cyrygbg.tokentracker.personal"

    static func version(_ tag: String) -> String? {
        guard tag.range(of: "^personal-v[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil else { return nil }
        return String(tag.dropFirst("personal-v".count))
    }

    static func assetURL(_ value: String, tag: String, name: String) -> URL? {
        guard version(tag) != nil,
              let url = URL(string: value), url.scheme == "https", url.host == "github.com",
              url.port == nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path == "/\(repository)/releases/download/\(tag)/\(name)" else { return nil }
        return url
    }

    static func digest(_ body: String, name: String) -> String? {
        for line in body.split(separator: "\n") {
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
            guard parts.count == 2 else { continue }
            let hex = String(parts[0])
            let file = parts[1].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "*"))
            if file == name, hex.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil { return hex.lowercased() }
        }
        return nil
    }

    static func verifies(_ file: URL, digest: String) throws -> Bool {
        guard digest.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else { return false }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 65536), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() == digest.lowercased()
    }
}
