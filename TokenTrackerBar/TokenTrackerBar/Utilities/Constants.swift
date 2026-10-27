import Foundation

enum Constants {
    static var trackerDirectory: URL {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path
        return URL(fileURLWithPath: home).appendingPathComponent(".tokentracker-personal/tracker", isDirectory: true)
    }
    static let serverBaseURL = NativeQAProfile.current?.origin ?? "http://localhost:17680"
    static let serverPort = NativeQAProfile.current?.baseURL.port ?? 17680
    static let autoRefreshInterval: TimeInterval = 300
    static let healthCheckInterval: TimeInterval = 30
    static let maxHeatmapWeeks = 52
}
