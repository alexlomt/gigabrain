// Generated from index.ts deterministically by scripts/build-runtime-js.js.
import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import {
  hasSessionPrelude,
  markSessionBriefed,
  registerOpenClawCompatibility,
} from './lib/compat/openclaw-adapter.js';
import { deriveScopeFromWorkspaceDir } from './lib/compat/scope-policy.js';















const isRecord = (value         )                                   => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const resolvePluginConfig = (raw         )                          => {
  if (!isRecord(raw)) return {};
  const nested = (raw       )?.plugins?.entries?.gigabrain?.config;
  return isRecord(nested) ? nested : raw;
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