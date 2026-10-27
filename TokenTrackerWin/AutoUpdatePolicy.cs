using System.IO;
using System.Text.Json.Nodes;

namespace TokenTrackerWin;

/// <summary>
/// Persists the Windows automatic-update preference alongside the other native
/// settings. A missing value intentionally means DISABLED in this fork: the
/// fork has no release channel of its own and the bundled updater's URLs still
/// point at the upstream repo, so a silent launch check could overwrite this
/// fork with the official build. Manual "Check for Updates" is never gated.
/// </summary>
internal static class AutoUpdatePolicy
{
    public const string EnabledKey = "UpdateChecker.autoUpdateEnabled";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TokenTrackerPersonal",
        "native-settings.json");

    public static bool IsEnabled() => ResolveEnabled(ReadSettings());

    /// <summary>
    /// Resolve a persisted settings object, defaulting to disabled. A valid
    /// boolean must survive; only a missing or malformed value (e.g. persisted
    /// as a string by an older build) falls back to disabled.
    /// </summary>
    internal static bool ResolveEnabled(JsonObject? settings)
    {
        if (settings?[EnabledKey] is JsonValue value
            && value.TryGetValue<bool>(out var enabled))
        {
            return enabled;
        }

        return false;
    }

    public static void SetEnabled(bool enabled)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
            var settings = ReadSettings();
            settings[EnabledKey] = enabled;
            File.WriteAllText(SettingsPath, settings.ToJsonString());
        }
        catch
        {
            // Preferences are best effort. A failed write leaves the default-off
            // behaviour intact for the next launch.
        }
    }

    private static JsonObject ReadSettings()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(SettingsPath))?.AsObject() ?? new JsonObject();
        }
        catch
        {
            return new JsonObject();
        }
    }
}
