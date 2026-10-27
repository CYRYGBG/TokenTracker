import XCTest

final class UpdateCheckerAutoUpdateTests: XCTestCase {

    private func makeIsolatedDefaults() -> (UserDefaults, String) {
        let suiteName = "UpdateCheckerAutoUpdateTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, suiteName)
    }

    func testAutoUpdateDefaultsToDisabledWhenUnset() {
        let (defaults, suiteName) = makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertFalse(
            AutoUpdatePolicy.isEnabled(defaults),
            "the fork has no release channel; a silent check would install the upstream build, so auto-update must default to disabled"
        )
    }

    func testAutoUpdateReadsPersistedToggle() {
        let (defaults, suiteName) = makeIsolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(false, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertFalse(AutoUpdatePolicy.isEnabled(defaults))

        defaults.set(true, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertTrue(AutoUpdatePolicy.isEnabled(defaults))
    }

    func testAutoUpdateRoundTripsThroughStandardDefaults() {
        let original = AutoUpdatePolicy.isEnabled()
        defer { UserDefaults.standard.set(original, forKey: AutoUpdatePolicy.enabledKey) }

        UserDefaults.standard.set(false, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertFalse(AutoUpdatePolicy.isEnabled())

        UserDefaults.standard.set(true, forKey: AutoUpdatePolicy.enabledKey)
        XCTAssertTrue(AutoUpdatePolicy.isEnabled())
    }
}
