import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import {
  hasSessionPrelude,
  markSessionBriefed,
  registerOpenClawCompatibility,
} from './lib/compat/openclaw-adapter.js';
import { createAutoCaptureHook } from './lib/compat/auto-capture-policy.js';
import { deriveScopeFromWorkspaceDir } from './lib/compat/scope-policy.js';

type PluginApi = {
  config?: unknown;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  on?: (event: string, handler: (...args: any[]) => any) => void;
  registerCli?: (registrar: (...args: any[]) => any, options?: unknown) => void;
  registerMemoryCapability?: (capability: unknown) => void;
  registerHttpHandler?: (handler: (...args: any[]) => any) => void;
  registerHttpRoute?: (route: unknown) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const resolvePluginConfig = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) return {};
  const nested = (raw as any)?.plugins?.entries?.gigabrain?.config;
  return isRecord(nested) ? nested : raw;
};

const enqueueAutoCaptureEvent = async (payload: unknown) => {
  const queueModule = await import('./lib/compat/auto-capture-queue.js');
  if (typeof queueModule.enqueueAutoCaptureEvent !== 'function') {
    throw new Error('AUTO_CAPTURE_ENQUEUE_UNAVAILABLE');
  }
  return queueModule.enqueueAutoCaptureEvent(payload as any);
};

const gigabrainPlugin = {
  id: 'gigabrain',
  name: 'Gigabrain',
  description: 'Source-first observational memory adapter for OpenClaw',
  kind: 'memory' as const,
  configSchema: V3_CONFIG_SCHEMA,
  register(api: PluginApi) {
    const config = normalizeConfig(resolvePluginConfig(api.config), {
      workspaceRoot: process.cwd(),
    });
    if (config.enabled === false) {
      api.logger?.info?.('[gigabrain] disabled by config');
      return;
    }
    registerOpenClawCompatibility(api, config);
    const autoCapture = (config as any)?.capture?.autoCapture;
    if ((config as any)?.capture?.enabled !== false && autoCapture?.enabled === true && autoCapture?.mode !== 'off') {
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
