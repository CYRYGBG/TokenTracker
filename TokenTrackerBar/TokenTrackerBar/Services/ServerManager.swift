import Foundation
import Combine
import Darwin

@MainActor
final class ServerManager: ObservableObject {

    enum Status: Equatable {
        case idle
        case starting
        case running
        case failed(String)
    }

    @Published var status: Status = .idle

    var isServerRunning: Bool { status == .running }

    private var serverProcess: Process?
    private var healthCheckTask: Task<Void, Never>?

    // MARK: - Lifecycle

    /// Ensure a healthy server is available. Safe to call repeatedly (launch,
    /// wake, retry): when our own child process is alive and the server answers
    /// health checks, this is a no-op — it never tears down a healthy server.
    func ensureServerRunning() async {
        guard !NativeQAProfile.isQABuild else { fatalError("Native QA cannot launch or replace a server") }
        if let process = serverProcess, process.isRunning,
           await APIClient.shared.checkServerHealth() {
            status = .running
            return
        }

        status = .starting

        // Try embedded server first
        if let embedded = findEmbeddedServer() {
            // Kill any stale server on the port so we always run the bundled version
            await killExistingServerOnPort()
            launchServer(nodePath: embedded.nodePath, entryPath: embedded.entryPath)
        } else {
            status = .failed(Strings.serverNotAvailableMessage)
            return
        }

        // Poll until server responds (up to 15 seconds) with exponential backoff
        let started = await waitForServer(timeout: 15)
        if started {
            status = .running
            startHealthCheckLoop(ownership: .ownedProcess)
        } else {
            status = .failed(Strings.serverNotResponding(port: Constants.serverPort))
        }
    }

    /// Gracefully stop the server process when app quits.
    func stopServer() {
        healthCheckTask?.cancel()
        healthCheckTask = nil

        guard let process = serverProcess else { return }
        serverProcess = nil
        process.terminationHandler = nil
        guard process.isRunning else { return }

        // The app may exit immediately after this callback. Give our owned
        // Node child time to finish its 3-second graceful shutdown before the
        // parent disappears; never signal another listener on the same port.
        let pid = process.processIdentifier
        Darwin.kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(4)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            Darwin.kill(pid, SIGKILL)
        }
    }

    /// Retry starting the server (e.g. from a Retry button).
    func retry() async {
        stopServer()
        await ensureServerRunning()
    }

    // MARK: - Kill Stale Server

    /// Kill any existing process listening on the server port so the embedded server can bind.
    /// Matches LISTEN sockets only: a bare `lsof -ti tcp:<port>` also lists processes with
    /// *client* connections to the port — including this app's own URLSession keep-alive
    /// sockets — and SIGTERMing that list makes the app kill itself. Its own PID is
    /// excluded as a second line of defense.
    private nonisolated func killExistingServerOnPort() async {
        // Never signal an arbitrary listener. Only stopServer owns our child.
    }

    // MARK: - Find Embedded Server

    private func findEmbeddedServer() -> (nodePath: String, entryPath: String)? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }

        let nodePath = resourceURL
            .appendingPathComponent("EmbeddedServer/node")
            .path
        let entryPath = resourceURL
            .appendingPathComponent("EmbeddedServer/tokentracker/bin/tracker.js")
            .path

        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: nodePath),
              fm.fileExists(atPath: entryPath) else {
            return nil
        }

        return (nodePath, entryPath)
    }

    // MARK: - Find Binary

    private func findTokenTrackerBinary() -> String? {
        // 1. Check if `tokentracker` is in PATH using shell
        if let path = shellWhich("tokentracker") {
            return path
        }

        // 2. Common global npm binary locations
        let candidates = [
            "/opt/homebrew/bin/tokentracker",
            "/usr/local/bin/tokentracker",
            "\(NSHomeDirectory())/.npm-global/bin/tokentracker",
            "\(NSHomeDirectory())/n/bin/tokentracker",
        ]
        for candidate in candidates {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        // 3. Try to resolve via `npm bin -g`
        if let npmGlobalBin = shellOutput("/bin/zsh", args: ["-lc", "npm bin -g 2>/dev/null"]) {
            let path = npmGlobalBin.trimmingCharacters(in: .whitespacesAndNewlines) + "/tokentracker"
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }

        return nil
    }

    private func shellWhich(_ command: String) -> String? {
        // Use login shell to get full PATH
        guard let output = shellOutput("/bin/zsh", args: ["-lc", "which \(command) 2>/dev/null"]) else {
            return nil
        }
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else {
            return nil
        }
        return path
    }

    private nonisolated func shellOutput(_ launchPath: String, args: [String]) -> String? {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = args
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.environment = ProcessInfo.processInfo.environment.merging(["TOKENTRACKER_PERSONAL": "1"]) { _, new in new }
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }

    // MARK: - Launch Server

    /// Launch using the embedded Node.js binary — no login shell needed.
    private func launchServer(nodePath: String, entryPath: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [entryPath, "serve", "--port", "\(Constants.serverPort)", "--no-sync", "--no-open"]
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        var env = ProcessInfo.processInfo.environment
        env["TOKENTRACKER_PERSONAL"] = "1"
        env["NODE_ENV"] = "production"
        env["HOME"] = env["HOME"] ?? NSHomeDirectory()
        env["TOKENTRACKER_APP_SHELL"] = "macos"
        process.environment = env

        process.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.status == .running {
                    self.status = .failed(Strings.serverExitedUnexpectedly)
                }
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            status = .failed(Strings.embeddedServerLaunchFailed(error.localizedDescription))
        }
    }

    /// Fall back to system-installed CLI via login shell.
    private func launchServer(at binaryPath: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Use login shell so Node.js/npm PATH is available
        process.arguments = ["-lc", "\(binaryPath) serve --port \(Constants.serverPort) --no-sync"]
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        var fallbackEnv = ProcessInfo.processInfo.environment
        fallbackEnv["TOKENTRACKER_PERSONAL"] = "1"
        fallbackEnv["TOKENTRACKER_APP_SHELL"] = "macos"
        process.environment = fallbackEnv

        // Clean up if process dies unexpectedly
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.status == .running {
                    self.status = .failed(Strings.serverExitedUnexpectedly)
                }
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            status = .failed(Strings.serverLaunchFailed(error.localizedDescription))
        }
    }

    // MARK: - Wait for Server (with exponential backoff)

    private func waitForServer(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        var delay: UInt64 = 200 // start at 200ms
        let maxDelay: UInt64 = 2000

        while Date() < deadline {
            let healthy = await APIClient.shared.checkServerHealth()
            if healthy { return true }
            try? await Task.sleep(nanoseconds: delay * 1_000_000)
            delay = min(delay * 2, maxDelay)
        }
        return false
    }

    // MARK: - Health Check Loop

    private func startHealthCheckLoop(ownership: ServerHealthCheckPolicy.Ownership) {
        healthCheckTask?.cancel()
        let interval = ServerHealthCheckPolicy.interval(for: ownership)
        healthCheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled, let self else { break }
                let healthy = await APIClient.shared.checkServerHealth()
                if healthy {
                    self.status = .running
                } else {
                    self.status = .failed(Strings.serverBecameUnreachable)
                }
            }
        }
    }
}
