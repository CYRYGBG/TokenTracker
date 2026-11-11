// Block maintenance until the parent has exercised the real HTTP listener.
const init = require("../../src/commands/init");
const sync = require("../../src/commands/sync");
const pricing = require("../../src/lib/pricing");
const telemetry = require("../../src/lib/telemetry");
pricing.ensurePricingLoaded = async () => {};
telemetry.maybeSendHeartbeat = async () => {};
init.installLocalTrackerApp = async () => {
  process.send({ phase: "install" });
  await new Promise((resolve) => process.once("message", resolve));
};
init.repairRuntimeIntegrations = async () => {
  process.send({ phase: "repair" });
  return { warnings: [] };
};
init.cmdInit = async () => { process.send({ phase: "init" }); };
// The fork removed the star CTA that upstream uses as the completion signal;
// the post-listen startup sync is the last blocking step in the fork's
// cmdServe, so it emits both phases here.
sync.cmdSync = async () => {
  process.send({ phase: "sync" });
  process.send({ phase: "complete" });
};
require("../../src/commands/serve").cmdServe(["--port", process.argv[2], "--no-open"])
  .catch((error) => { console.error(error); process.exit(1); });
