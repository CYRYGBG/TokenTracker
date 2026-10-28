import Foundation

/// Same local handshake used by the CLI's duplicate-server check. A dashboard
/// HTML fallback or a removed account endpoint cannot prove API readiness.
enum LocalServerHealth {
    static let path = "/api/local-auth"

    private struct Handshake: Decodable {
        let token: String
        let serverVersion: String
    }

    static func isHealthy(data: Data, statusCode: Int, expectedVersion: String) -> Bool {
        guard statusCode == 200, !expectedVersion.isEmpty,
              let handshake = try? JSONDecoder().decode(Handshake.self, from: data),
              !handshake.token.isEmpty else { return false }
        return handshake.serverVersion == expectedVersion
    }
}
