import AppKit
import Foundation

@MainActor
final class UpdateChecker {

    static let shared = UpdateChecker()

    private let releaseURL: String = "https://github.com/CYRYGBG/TokenTracker/releases/latest"

    /// HTTP resolution with rate-limit cooldown and releases-page fallback
    /// (adapted from the upstream macOS fix 7e65d77 to the personal channel).
    /// UI-free and driven by the CLT harness; see PersonalUpdateReleaseClient.swift.
    private let releaseClient = PersonalUpdateReleaseClient()

    /// Observable status for menu item display
    private(set) var statusText: String? = nil {
        didSet { postStatusDidChangeNotification() }
    }

    private(set) var isBusy = false {
        didSet { postStatusDidChangeNotification() }
    }

    /// Retain delegate until download completes (URLSession holds weak ref only)
    private var activeDownloadDelegate: ResumableDownloader?

    /// Native progress panel, present only during user-initiated (non-silent) updates
    private var progressPanel: UpdateProgressPanelController?

    /// Cached app icon for alerts (capture before activationPolicy changes)
    private lazy var appIcon: NSImage? = NSApp.applicationIconImage

    private func postStatusDidChangeNotification() {
        NotificationCenter.default.post(name: .updateCheckerStatusDidChange, object: self)
    }

    // MARK: - Public

    /// Whether launch-time silent checks may run (and thereby auto-download/install).
    /// Storage lives in `AutoUpdatePolicy` (GitHub discussion #424); manual
    /// "Check for Updates" (non-silent) is never gated.
    var autoUpdateEnabled: Bool {
        get { AutoUpdatePolicy.isEnabled() }
        set { UserDefaults.standard.set(newValue, forKey: AutoUpdatePolicy.enabledKey) }
    }

    func check(silent: Bool = false) {
        guard !isBusy else { return }

        // Auto-update toggle: silent checks are exclusively launch-time background
        // checks whose success path downloads and installs without prompting, so the
        // toggle short-circuits them before any network call. Manual (non-silent)
        // checks stay available regardless of the toggle.
        if silent, !AutoUpdatePolicy.isEnabled() {
            Swift.print("[UpdateChecker] Skipping silent update check: auto-update is disabled")
            return
        }

        // Developer / Debug path guard:
        // Skip automatic silent background checks if the application is running from outside
        // the standard Applications directories (e.g., from Xcode DerivedData).
        // This prevents developer builds from being replaced by personal GitHub releases.
        if silent {
            let path = Bundle.main.bundlePath
            let inStandardApps = path.hasPrefix("/Applications/") || path.hasPrefix("/Users/\(NSUserName())/Applications/")
            if !inStandardApps {
                Swift.print("[UpdateChecker] Skipping silent update check: running from non-standard path \(path)")
                return
            }
        }

        isBusy = true
        statusText = Strings.updateChecking

        Task.detached { [self] in
            let result: Result<GitHubRelease, Error>
            do {
                result = .success(try await self.fetchLatestRelease())
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                self.handleResult(result, silent: silent)
            }
        }
    }

    // MARK: - Release Resolution (URLSession — respects system proxy)

    nonisolated private func fetchLatestRelease() async throws -> GitHubRelease {
        // The client owns throttling detection, cooldown and the releases-page
        // fallback; the returned release is already validated (stable
        // personal-vX.Y.Z tag, exact platform asset, same-tag SHA256SUMS digest).
        try await releaseClient.fetchLatestRelease()
    }

    // MARK: - Result Handling

    private func handleResult(_ result: Result<GitHubRelease, Error>, silent: Bool) {
        switch result {
        case .success(let release):
            // The API may have been throttled even though the releases-page
            // fallback succeeded. promptUpdate/finishUpdate clear statusText,
            // so reapply the cooldown status unless the download progress
            // owns the channel.
            let rateLimited = releaseClient.isAPICoolingDown
            let current = currentVersion()
            if compareVersions(current, release.tagVersion) == .orderedAscending {
                if silent, let dmg = release.dmgAsset {
                    // Loop guard: if we just silently installed this exact release but
                    // the app still reports itself as older, the downloaded DMG's
                    // Info.plist is out of sync with the git tag (issue #34 / 0.5.77).
                    // Reinstalling would copy the same broken DMG on every relaunch
                    // forever — skip instead and surface the problem via statusText.
                    if isRecentlyInstalled(release.tagVersion) {
                        finishUpdate()
                        statusText = Strings.updateSkipped(target: release.tagVersion, current: current)
                        Swift.print("[UpdateChecker] Silent install loop averted: target=\(release.tagVersion), current=\(current)")
                        return
                    }
                    // Silent auto-update: download and install without prompting
                    startDownloadAndInstall(dmg, expectedDigest: release.expectedDigest ?? "", targetVersion: release.tagVersion, interactive: false)
                } else {
                    promptUpdate(release: release, currentVersion: current)
                    if rateLimited {
                        statusText = Strings.updateRateLimitedStatus
                    }
                }
            } else {
                finishUpdate()
                if rateLimited {
                    statusText = Strings.updateRateLimitedStatus
                }
                if !silent {
                    statusText = Strings.upToDateMessage(current)
                    showAlert(title: Strings.upToDateTitle, message: Strings.upToDateMessage(current), style: .informational)
                }
            }
        case .failure(let error):
            finishUpdate()
            // Rate-limit context: the API is cooling down, so a failure here
            // means the releases-page fallback failed too. Show that in the
            // menu status channel instead of a bare HTTP error.
            let coolingDown = releaseClient.isAPICoolingDown
            var message = error.localizedDescription
            if let retryAt = releaseClient.apiRetryAt, retryAt > Date() {
                message += "\n\n" + Strings.updateRateLimitedRetryAt(Self.retryTimeText(retryAt))
            }
            if coolingDown {
                statusText = Strings.updateRateLimitedStatus
            }
            if !silent {
                if !coolingDown {
                    statusText = "\(Strings.updateCheckFailedTitle): \(error.localizedDescription)"
                }
                showAlert(
                    title: Strings.updateCheckFailedTitle,
                    message: "\(message)\n\n\(Strings.manualCheckHint)",
                    style: .warning,
                    showReleasePage: true
                )
            }
        }
    }

    private func finishUpdate() {
        isBusy = false
        statusText = nil
        progressPanel?.close()
        progressPanel = nil
    }

    // MARK: - Version

    func currentVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
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

    // MARK: - Loop Protection

    /// Persisted identity of the most recent DMG that `mountCopyRelaunch` finished
    /// copying into `/Applications`. The silent `check()` path consults this to
    /// detect an install loop: if the tag it just fetched matches what we freshly
    /// installed *and* the app still reports an older `CFBundleShortVersionString`,
    /// the DMG's Info.plist MARKETING_VERSION is out of sync with the git tag
    /// (root cause of issue #34 / 0.5.77) and reinstalling would loop forever.
    private static let lastInstalledVersionKey = "UpdateChecker.lastInstalledVersion"
    private static let lastInstalledAtKey = "UpdateChecker.lastInstalledAt"

    /// How long after a successful install we treat "please install the same
    /// version again" as a loop rather than a legitimate reinstall request.
    /// Long enough to survive the next launch's silent check, short enough that
    /// a deliberate reinstall hours later still goes through.
    private let loopGuardWindow: TimeInterval = 10 * 60

    private func recordInstalledVersion(_ version: String) {
        let d = UserDefaults.standard
        d.set(version, forKey: Self.lastInstalledVersionKey)
        d.set(Date().timeIntervalSince1970, forKey: Self.lastInstalledAtKey)
    }

    private func isRecentlyInstalled(_ version: String) -> Bool {
        let d = UserDefaults.standard
        guard let last = d.string(forKey: Self.lastInstalledVersionKey), last == version else {
            return false
        }
        let at = d.double(forKey: Self.lastInstalledAtKey)
        guard at > 0 else { return false }
        return (Date().timeIntervalSince1970 - at) < loopGuardWindow
    }

    // MARK: - UI

    private func promptUpdate(release: GitHubRelease, currentVersion: String) {
        isBusy = false
        statusText = nil

        let alert = NSAlert()
        alert.messageText = Strings.newVersionTitle(release.tagVersion)
        // Keep the prompt lean: version + size only. Release notes are markdown,
        // which NSAlert can't render — intentionally omitted.
        alert.informativeText = buildUpdateMessage(release: release, currentVersion: currentVersion)
        alert.alertStyle = .informational
        alert.icon = appIcon
        alert.addButton(withTitle: release.dmgAsset != nil ? Strings.downloadInstallButton : Strings.viewOnGitHubButton)
        alert.addButton(withTitle: Strings.laterButton)

        presentAlert(alert) { response in
            if response == .alertFirstButtonReturn {
                if let dmg = release.dmgAsset {
                    self.startDownloadAndInstall(dmg, expectedDigest: release.expectedDigest ?? "", targetVersion: release.tagVersion, interactive: true)
                } else if let url = URL(string: release.html_url) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    private func buildUpdateMessage(release: GitHubRelease, currentVersion: String) -> String {
        var lines = [Strings.updateCurrentLine(current: currentVersion, target: release.tagVersion)]
        if let dmg = release.dmgAsset {
            lines.append(Strings.updateSize(String(format: "%.1f", Double(dmg.size) / 1_048_576)))
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Download + Install (URLSession for proxy support)

    private func startDownloadAndInstall(_ asset: GitHubRelease.Asset, expectedDigest: String, targetVersion: String, interactive: Bool) {
        isBusy = true
        let totalSize = Int64(asset.size)
        let totalMB = Double(totalSize) / 1_048_576
        statusText = Strings.downloadingPercent(0)

        if interactive {
            let panel = UpdateProgressPanelController()
            panel.show(title: Strings.updateProgressTitle(targetVersion))
            panel.setProgress(percent: 0, detail: Strings.downloadingPercent(0))
            progressPanel = panel
        }

        // Download into the app's own data directory rather than ~/Downloads/.
        // Downloads is TCC-protected on macOS, so writing there triggers a
        // "TokenTrackerBar wants to access files in your Downloads folder"
        // prompt every time silent auto-update fires — particularly noisy
        // for ad-hoc-signed builds where TCC grants don't persist across
        // re-installs. Application Support is owned by the user and not
        // gated by TCC, so the silent updater stays silent.
        let supportDir = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ))?.appendingPathComponent("TokenTrackerPersonal/updates", isDirectory: true)
            ?? FileManager.default.temporaryDirectory
        if !FileManager.default.fileExists(atPath: supportDir.path) {
            try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        }
        let safeVersion = targetVersion.map { character -> Character in
            character.isLetter || character.isNumber || character == "." || character == "-" ? character : "_"
        }
        let destURL = supportDir.appendingPathComponent("\(String(safeVersion))-\(asset.name)")
        let retainedNames = Set([
            destURL.lastPathComponent,
            destURL.appendingPathExtension("part").lastPathComponent,
            destURL.appendingPathExtension("resume.json").lastPathComponent,
        ])
        if let staleFiles = try? FileManager.default.contentsOfDirectory(
            at: supportDir,
            includingPropertiesForKeys: nil
        ) {
            for staleFile in staleFiles where !retainedNames.contains(staleFile.lastPathComponent) {
                try? FileManager.default.removeItem(at: staleFile)
            }
        }

        guard let url = URL(string: asset.browser_download_url) else {
            finishUpdate()
            showAlert(
                title: Strings.downloadFailedTitle,
                message: Strings.invalidDownloadURL,
                style: .warning,
                showReleasePage: true
            )
            return
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 900

        let delegate = ResumableDownloader(
            destinationURL: destURL,
            expectedSize: totalSize,
            configuration: config,
            onProgress: { [weak self] received, expected in
                guard let self else { return }
                let denom = expected > 0 ? expected : totalSize
                guard denom > 0 else {
                    self.statusText = Strings.downloadingUnknown
                    self.progressPanel?.setIndeterminate(detail: Strings.downloadingUnknown)
                    return
                }
                let fraction = Double(received) / Double(denom) * 100
                let pct = min(Int(fraction), 99)
                let receivedMB = Double(received) / 1_048_576
                let progressText = Strings.downloadingProgress(
                    pct: pct,
                    receivedMB: String(format: "%.0f", receivedMB),
                    totalMB: String(format: "%.0f", totalMB)
                )
                self.statusText = progressText
                self.progressPanel?.setProgress(percent: fraction, detail: progressText)
            },
            onRetry: { attempt, error in
                Swift.print("[UpdateChecker] Download retry \(attempt): \(error.localizedDescription)")
            },
            onComplete: { [weak self] result in
                guard let self else { return }
                self.activeDownloadDelegate = nil
                switch result {
                case .success(let dmgURL):
                    self.statusText = Strings.installing
                    self.progressPanel?.setIndeterminate(detail: Strings.installing)
                    self.performInstallAsync(dmgURL, expectedDigest: expectedDigest, targetVersion: targetVersion)
                case .failure(let error):
                    self.finishUpdate()
                    self.showAlert(
                        title: Strings.downloadFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualDownloadHint)",
                        style: .warning,
                        showReleasePage: true
                    )
                }
            }
        )
        activeDownloadDelegate = delegate

        delegate.start(url: url)
    }

    private func performInstallAsync(_ dmgURL: URL, expectedDigest: String, targetVersion: String) {
        let dmgPath = dmgURL.path
        Task.detached { [self] in
            let result: Result<URL, Error>
            do {
                guard try PersonalUpdateChannel.verifies(dmgURL, digest: expectedDigest) else {
                    try? FileManager.default.removeItem(at: dmgURL)
                    throw UpdateError.installFailed("Downloaded update failed SHA-256 verification")
                }
                result = .success(try self.mountCopyRelaunch(dmgPath: dmgPath, targetVersion: targetVersion))
            } catch {
                result = .failure(error)
            }

            await MainActor.run {
                switch result {
                case .success(let appURL):
                    self.recordInstalledVersion(targetVersion)
                    self.statusText = Strings.restarting
                    self.progressPanel?.setIndeterminate(detail: Strings.restarting)
                    self.relaunch(appURL: appURL)
                case .failure(let error):
                    self.finishUpdate()
                    self.showAlert(
                        title: Strings.installationFailedTitle,
                        message: "\(error.localizedDescription)\n\n\(Strings.manualInstallHint)",
                        style: .warning
                    )
                }
            }
        }
    }

    // MARK: - Install Logic

    nonisolated private func mountCopyRelaunch(dmgPath: String, targetVersion: String) throws -> URL {
        // 1. Mount
        let mount = Process()
        mount.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        mount.arguments = ["attach", dmgPath, "-nobrowse", "-mountrandom", "/tmp"]
        let mountPipe = Pipe()
        mount.standardOutput = mountPipe
        mount.standardError = Pipe()
        try mount.run()
        mount.waitUntilExit()
        guard mount.terminationStatus == 0 else { throw UpdateError.installFailed("Failed to mount DMG") }

        let mountOutput = String(data: mountPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let mountPoint = mountOutput.split(separator: "\n").last?.split(separator: "\t").last?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !mountPoint.isEmpty, FileManager.default.fileExists(atPath: mountPoint) else {
            throw UpdateError.installFailed("Mount point not found")
        }

        defer {
            let detach = Process()
            detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            detach.arguments = ["detach", mountPoint, "-quiet", "-force"]
            detach.standardOutput = Pipe()
            detach.standardError = Pipe()
            try? detach.run()
            detach.waitUntilExit()
        }

        // 2. Find .app
        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(atPath: mountPoint)
        guard let appName = contents.first(where: { $0 == "TokenTrackerPersonal.app" }) else {
            throw UpdateError.installFailed("No .app found in DMG")
        }

        let appsDir = URL(fileURLWithPath: "/Applications", isDirectory: true)
        let sourceApp = URL(fileURLWithPath: mountPoint).appendingPathComponent(appName)
        let destApp = appsDir.appendingPathComponent(appName)
        try PersonalUpdateInstaller.install(source: sourceApp, destination: destApp, version: targetVersion)

        // 4. Cleanup DMG
        try? fm.removeItem(atPath: dmgPath)

        return destApp
    }

    private func relaunch(appURL: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "i=0; while kill -0 \"$1\" 2>/dev/null; do i=$((i+1)); [ \"$i\" -lt 200 ] || exit 1; sleep 0.1; done; exec /usr/bin/open -n \"$2\"", "personal-update", String(ProcessInfo.processInfo.processIdentifier), appURL.path]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { AppDelegate.requestQuit() }
        } catch {
            finishUpdate()
            showAlert(title: Strings.updateCompleteTitle, message: Strings.updateCompleteMessage, style: .informational)
        }
    }

    // MARK: - Helpers

    private func showAlert(title: String, message: String, style: NSAlert.Style, showReleasePage: Bool = false) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.icon = appIcon
        if showReleasePage {
            alert.addButton(withTitle: Strings.openReleasesPageButton)
            alert.addButton(withTitle: Strings.okButton)
        } else {
            alert.addButton(withTitle: Strings.okButton)
        }
        presentAlert(alert) { response in
            if showReleasePage && response == .alertFirstButtonReturn {
                if let url = URL(string: self.releaseURL) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    /// 更新提示必须压过菜单栏 Popover（NSPanel）；仅用 sheet 仍可能被 Popover 挡住，故统一 `runModal` 并把模态窗提到高层级。
    /// 注意：不要在这里 order front 仪表盘窗口——靠下方的 level bump 已足够置顶，强开仪表盘会打扰用户。
    private func presentAlert(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        let previousActivationPolicy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.regular)
        StatusBarController.prepareForSystemAlert()
        NSApp.activate(ignoringOtherApps: true)

        var bumpTimer: Timer?
        let bumpAttempts = BumpAttempts()
        bumpTimer = Timer(timeInterval: 0.02, repeats: true) { t in
            bumpAttempts.count += 1
            if bumpAttempts.count > 250 {
                t.invalidate()
                return
            }
            guard let modal = NSApp.modalWindow else { return }
            modal.level = .popUpMenu
            modal.orderFrontRegardless()
            t.invalidate()
        }
        if let timer = bumpTimer {
            RunLoop.current.add(timer, forMode: .common)
            RunLoop.current.add(timer, forMode: .modalPanel)
        }

        let response = alert.runModal()
        bumpTimer?.invalidate()
        NSApp.setActivationPolicy(previousActivationPolicy)
        completion(response)
    }

    private final class BumpAttempts {
        var count = 0
    }

    /// "Retry after" line for alerts, formatted in the app's resolved locale so
    /// the date matches the surrounding alert text (mirrors the Windows
    /// ApiRetryAtMessage).
    private static func retryTimeText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: NativeLocalization.currentResolvedLocale)
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private enum UpdateError: LocalizedError {
        case emptyResponse
        case installFailed(String)
        case noRelease

        var errorDescription: String? {
            switch self {
            case .emptyResponse: return Strings.emptyServerResponse
            case .installFailed(let reason): return Strings.installFailed(reason)
            case .noRelease: return Strings.noReleaseAvailable
            }
        }
    }
}

extension Notification.Name {
    /// Posted when `UpdateChecker.shared.statusText` or `isBusy` changes (menu bar can refresh without polling).
    static let updateCheckerStatusDidChange = Notification.Name("UpdateCheckerStatusDidChange")
}
