import Foundation

/// Verifies and stages the replacement before changing an existing installation.
/// Kept independent of AppKit so failures can be tested in a temporary directory.
enum PersonalUpdateInstaller {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    static func install(source: URL, destination: URL, version: String) throws {
        guard let bundle = Bundle(url: source),
              bundle.bundleIdentifier == PersonalUpdateChannel.bundleIdentifier,
              bundle.infoDictionary?["CFBundleShortVersionString"] as? String == version else {
            throw Failure("Update bundle identity or version does not match the personal release")
        }
        let verify = Process()
        verify.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        verify.arguments = ["--verify", "--deep", "--strict", source.path]
        verify.standardOutput = FileHandle.nullDevice
        verify.standardError = FileHandle.nullDevice
        try verify.run()
        verify.waitUntilExit()
        guard verify.terminationStatus == 0 else { throw Failure("Update bundle signature is invalid") }

        let fm = FileManager.default
        let parent = destination.deletingLastPathComponent()
        let prefix = ".\(destination.deletingPathExtension().lastPathComponent)-update-"
        let staging = parent.appendingPathComponent(prefix + UUID().uuidString)
        // An interrupted copy has no .app extension and cannot appear in app search.
        defer { try? fm.removeItem(at: staging) }
        try fm.copyItem(at: source, to: staging)
        if fm.fileExists(atPath: destination.path) {
            _ = try fm.replaceItemAt(destination, withItemAt: staging)
        } else {
            try fm.moveItem(at: staging, to: destination)
        }
    }
}
