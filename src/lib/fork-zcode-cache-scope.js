const crypto = require("node:crypto");
const {
  loadZcodeAuthCandidates,
  loadZcodeLoginAccountId,
  zcodeProviderFamily,
} = require("./zcode-limits");

// Local-only fingerprint: never retain credentials in the quota cache and
// never reuse another account/plan/team's previously successful quota.
function zcodeCacheScope({ home, env } = {}) {
  const candidates = loadZcodeAuthCandidates({ home, env });
  if (!candidates.length) return null;
  return crypto.createHash("sha256").update(JSON.stringify(candidates.map((auth) => ({
    provider: auth.providerKey,
    plan: auth.planKind,
    account: auth.accountId,
    login: loadZcodeLoginAccountId(zcodeProviderFamily(auth.providerKey), { home, env }),
    team: auth.teamContext,
    credential: auth.apiKey,
  })))).digest("hex");
}

module.exports = { zcodeCacheScope };
