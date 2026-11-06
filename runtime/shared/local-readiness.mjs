// Configuration readiness is not optical acceptance or a production certificate.
export function localReadiness({ health, devices = [], routing, projectors, schedule, errors = [] }) {
  const physical = devices.filter(d => /Canon|EOS|R50/i.test(d.name ?? '') && !/NDI|virtual/i.test(d.name ?? ''));
  const units = projectors?.projectors ?? [];
  const config = schedule?.config ?? schedule?.schedule ?? schedule;
  const checks = {
    api: health?.ok === true,
    canonUsbDetected: physical.length > 0,
    receiverRoutingConfigured: routing?.enabled === true && new Set(routing.outputIds ?? []).size === 5 && routing.pendingRecovery !== true,
    fiveProjectorAddressesConfigured: units.filter(p => p.enabled === true && typeof p.host === 'string' && p.host.trim()).length === 5
      && projectors?.credential?.configured === true,
    weeklyScheduleConfigured: config?.enabled === true && Boolean(config.arenaExecutablePath && config.arenaCompositionPath)
      && config.days?.length === 7 && config.days.some(d => d.enabled === true),
  };
  return { schema:'pb-local-readiness-v1', checks, errors,
    configurationReady: Object.values(checks).every(Boolean) && errors.length === 0,
    cameraImageVerified:false, physicalProjectorVerified:false, powerCycleVerified:false,
    productionAutoReady:false };
}
