import Foundation

/// Persistence for the auto-update toggle (upstream GitHub discussion #424).
///
/// Foundation-only so the standalone TokenTrackerBarTests bundle can compile and
/// verify the default-off contract without pulling in the AppKit-coupled
/// `UpdateChecker`. The checker reads this before every silent launch check;
/// manual "Check for Updates" is never gated by it.
enum AutoUpdatePolicy {
    /// Missing preference means disabled. Manual checks remain available;
    /// only the personal GitHub release channel is accepted.
    static let enabledKey = "UpdateChecker.autoUpdateEnabled"

    static func isEnabled(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: enabledKey) as? Bool ?? false
    }
}
