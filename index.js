// Generated from index.ts deterministically by scripts/build-runtime-js.js.
import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import {
  hasSessionPrelude,
  markSessionBriefed,
  registerOpenClawCompatibility,
} from './lib/compat/openclaw-adapter.js';
import { createAutoCaptureHook } from './lib/compat/auto-capture-policy.js';
import { deriveScopeFromWorkspaceDir } from './lib/compat/scope-policy.js';















const isRecord = (value         )                                   => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const resolvePluginConfig = (raw         )                          => {
  if (!isRecord(raw)) return {};
  const nested = (raw       )?.plugins?.entries?.gigabrain?.config;
  return isRecord(nested) ? nested : raw;
};

const enqueueAutoCaptureEvent = async (payload         ) => {
  const queueModule = await import('./lib/compat/auto-capture-queue.js');
  if (typeof queueModule.enqueueAutoCaptureEvent !== 'function') {
    throw new Error('AUTO_CAPTURE_ENQUEUE_UNAVAILABLE');
  }
  return queueModule.enqueueAutoCaptureEvent(payload       );
};

const gigabrainPlugin = {
  id: 'gigabrain',
  name: 'Gigabrain',
  description: 'Source-first observational memory adapter for OpenClaw',
  kind: 'memory'         ,
  configSchema: V3_CONFIG_SCHEMA,
  register(api           ) {
    const config = normalizeConfig(resolvePluginConfig(api.config), {
      workspaceRoot: process.cwd(),
    });
    if (config.enabled === false) {
      api.logger?.info?.('[gigabrain] disabled by config');
      return;
    }
    registerOpenClawCompatibility(api, config);
    const autoCapture = (config       )?.capture?.autoCapture;
    if ((config       )?.capture?.enabled !== false && autoCapture?.enabled === true && autoCapture?.mode !== 'off') {
      api.on?.('agent_end', createAutoCaptureHook({
        config,
        enqueue: enqueueAutoCaptureEvent,
        logger: api.logger,
      }));
    }
  },
};

export default gigabrainPlugin;
export {
  deriveScopeFromWorkspaceDir,
  hasSessionPrelude,
  markSessionBriefed,
  registerOpenClawCompatibility,
};


//# sourceURL=index.ts