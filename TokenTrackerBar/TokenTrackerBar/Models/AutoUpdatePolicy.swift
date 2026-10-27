import Foundation

/// Persistence for the auto-update toggle (upstream GitHub discussion #424).
///
/// Foundation-only so the standalone TokenTrackerBarTests bundle can compile and
/// verify the default-off contract without pulling in the AppKit-coupled
/// `UpdateChecker`. The checker reads this before every silent launch check;
/// manual "Check for Updates" is never gated by it.
enum AutoUpdatePolicy {
    /// UserDefaults key backing the toggle. Missing value means DISABLED in this
    /// fork: the fork has no release channel of its own and the bundled
    /// updater's URLs still point at the upstream repo, so a silent launch check
    /// could overwrite this fork with the official build (M5 will remove those
    /// URLs; until then default-off is the guard).
    static let enabledKey = "UpdateChecker.autoUpdateEnabled"

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? false
    }
}
