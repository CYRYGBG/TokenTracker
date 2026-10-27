using System.Text.Json.Nodes;
using Xunit;

namespace TokenTrackerWin;

public sealed class AutoUpdatePolicyTests
{
    [Theory]
    [InlineData("false", false)]
    [InlineData("true", true)]
    [InlineData("\"false\"", false)]
    [InlineData("null", false)]
    public void DeserializedPreferencePreservesValidBooleans(string jsonValue, bool expected)
    {
        var settings = JsonNode.Parse("{\"" + AutoUpdatePolicy.EnabledKey + "\":" + jsonValue + "}")!.AsObject();
        Assert.Equal(expected, AutoUpdatePolicy.ResolveEnabled(settings));
    }

    [Fact]
    public void MissingPreferenceKeepsAutomaticUpdatesDisabled()
    {
        // The fork has no release channel; a silent check would install the
        // upstream build, so a missing preference must default to disabled.
        Assert.False(AutoUpdatePolicy.ResolveEnabled(new JsonObject()));
    }

    [Fact]
    public void PersistedPreferenceCanDisableAutomaticUpdates()
    {
        var settings = new JsonObject
        {
            [AutoUpdatePolicy.EnabledKey] = false,
        };

        Assert.False(AutoUpdatePolicy.ResolveEnabled(settings));
    }

    [Fact]
    public void PersistedPreferenceCanEnableAutomaticUpdates()
    {
        var settings = new JsonObject
        {
            [AutoUpdatePolicy.EnabledKey] = true,
        };

        Assert.True(AutoUpdatePolicy.ResolveEnabled(settings));
    }

    [Fact]
    public void MalformedPreferenceFallsBackToDisabled()
    {
        var settings = new JsonObject
        {
            // An older build could persist the value as a string; that is not
            // a user decision, so the fork default stays disabled.
            [AutoUpdatePolicy.EnabledKey] = "false",
        };

        Assert.False(AutoUpdatePolicy.ResolveEnabled(settings));
    }
}
