import React, { useEffect, useState } from "react";
import { forkApi } from "../lib/fork-api";
import { copy } from "../lib/copy";
import { localDeviceUsage, LOCAL_USAGE_CHANGED_EVENT } from "../lib/local-usage-transfer";
import { DeviceUsageCard } from "../ui/dashboard/components/DeviceUsageCard";

export function ForkDeviceUsageCard({ from, to, timeZone, tzOffsetMinutes, selectedDeviceId = "", onSelectDevice }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const query = new URLSearchParams({ from, to, tz: timeZone || "", tz_offset_minutes: String(tzOffsetMinutes ?? 0) });
        const result = await forkApi(`/api/fork/device-usage?${query}`);
        if (active && current === request) { setData(result); setError(""); }
      } catch (e) {
        if (active && current === request) setError(e.message);
      }
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener(LOCAL_USAGE_CHANGED_EVENT, refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener(LOCAL_USAGE_CHANGED_EVENT, refresh); };
  }, [from, to, timeZone, tzOffsetMinutes]);

  const selected = selectedDeviceId;
  const usage = localDeviceUsage(data?.devices || [], data?.account_sources || [], selected);
  return <div className="space-y-2">
    <DeviceUsageCard {...usage} showIdleDevices currentDeviceId={data?.current_device_id}
      selectedDeviceId={selected} onSelectDevice={onSelectDevice} />
    {(error || data?.partial) && <p role="alert" className="px-3 text-xs text-oai-gray-500">
      {copy("fork.devices.incomplete")} {error || data?.last_failure?.code}
    </p>}
  </div>;
}
