import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import { GIGABRAIN_HTTP_ROUTES, createMemoryHttpHandler } from './lib/core/http-routes.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from './lib/core/projection-store.js';
import { ensureEventStore } from './lib/core/event-store.js';
import { captureFromEvent } from './lib/core/capture-service.js';
import { enqueueAutoCaptureEvent } from './lib/core/auto-capture-service.js';
import { orchestrateRecall } from './lib/core/orchestrator.js';
import { ensureNativeStore, syncNativeMemory } from './lib/core/native-sync.js';
import { promoteNativeChunks } from './lib/core/native-promotion.js';
import { ensurePersonStore, rebuildEntityMentions } from './lib/core/person-service.js';
import { ensureWorldModelReady, ensureWorldModelStore, getSynthesis, rebuildWorldModel } from './lib/core/world-model.js';
import { registerGigabrainMemoryCli, gigabrainMemoryCliDescriptors } from './lib/core/openclaw-memory-cli.js';
import { gigabrainMemoryRuntime } from './lib/core/openclaw-memory-runtime.js';
import { openDatabase } from './lib/core/sqlite.js';
import { recordRecallLatency } from './lib/core/metrics.js';
const SILENT_REPLY_TOKEN = 'NO_REPLY';
const MEMORY_FLUSH_SOFT_TOKENS = 4000;
const MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MEMORY_FLUSH_RESERVE_TOKENS_FLOOR = 20000;
const MEMORY_FLUSH_TARGET_HINT = 'Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).';
const MEMORY_FLUSH_APPEND_ONLY_HINT = 'If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.';
const MEMORY_FLUSH_READ_ONLY_HINT = 'Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.';
const MEMORY_FLUSH_METADATA_HINT = 'Write only concise bullet points, and each durable bullet must end with Gigabrain metadata like <!-- gigabrain:scope=profile:main type=DECISION -->; if you cannot choose a concrete type, do not write the bullet.';
const normalizeNonNegativeInt = (value)=>{
    const num = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (!Number.isFinite(num)) return null;
    const int = Math.floor(num);
    return int >= 0 ? int : null;
};
const parseNonNegativeByteSize = (value)=>{
    if (typeof value === 'number') return normalizeNonNegativeInt(value);
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    const direct = normalizeNonNegativeInt(text);
    if (direct != null) return direct;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/);
    if (!match) return null;
    const multipliers = {
        b: 1,
        kb: 1024,
        mb: 1024 ** 2,
        gb: 1024 ** 3,
        tb: 1024 ** 4
    };
    return Math.floor(Number(match[1]) * multipliers[match[2]]);
};
const formatDateStampInTimezone = (nowMs, timezone = 'UTC')=>{
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date(nowMs));
        const year = parts.find((part)=>part.type === 'year')?.value;
        const month = parts.find((part)=>part.type === 'month')?.value;
        const day = parts.find((part)=>part.type === 'day')?.value;
        if (year && month && day) return `${year}-${month}-${day}`;
    } catch  {}
    return new Date(nowMs).toISOString().slice(0, 10);
};
const ensureNoReplyHint = (text)=>{
    if (text.includes(SILENT_REPLY_TOKEN)) return text;
    return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
};
const ensureMemoryFlushSafetyHints = (text)=>{
    let next = String(text || '').trim();
    for (const hint of [
        MEMORY_FLUSH_TARGET_HINT,
        MEMORY_FLUSH_APPEND_ONLY_HINT,
        MEMORY_FLUSH_READ_ONLY_HINT,
        MEMORY_FLUSH_METADATA_HINT
    ]){
        if (!next.includes(hint)) next = next ? `${next}\n\n${hint}` : hint;
    }
    return next;
};
const appendCurrentTimeLine = (text, nowMs, timezone)=>{
    const trimmed = String(text || '').trimEnd();
    if (trimmed.includes('Current time:')) return trimmed;
    return `${trimmed}\nCurrent time: ${new Date(nowMs).toISOString()} (${timezone})`;
};
const buildGigabrainMemoryFlushPlan = ({ config, params = {} })=>{
    const cfg = params?.cfg;
    const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
    if (defaults?.enabled === false) return null;
    const nowMs = Number.isFinite(Number(params?.nowMs)) ? Number(params.nowMs) : Date.now();
    const timezone = String(config?.runtime?.timezone || 'UTC').trim() || 'UTC';
    const dateStamp = formatDateStampInTimezone(nowMs, timezone);
    const prompt = ensureNoReplyHint(ensureMemoryFlushSafetyHints(String(defaults?.prompt || '').trim() || [
        'Pre-compaction memory flush for Gigabrain.',
        MEMORY_FLUSH_TARGET_HINT,
        MEMORY_FLUSH_READ_ONLY_HINT,
        MEMORY_FLUSH_APPEND_ONLY_HINT,
        MEMORY_FLUSH_METADATA_HINT,
        'Do NOT create timestamped variant files (for example YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.',
        `If nothing durable should be stored, reply with ${SILENT_REPLY_TOKEN}.`
    ].join(' ')));
    const systemPrompt = ensureNoReplyHint(ensureMemoryFlushSafetyHints(String(defaults?.systemPrompt || '').trim() || [
        'Pre-compaction memory flush turn.',
        'The session is near auto-compaction; capture only durable memories to disk.',
        MEMORY_FLUSH_TARGET_HINT,
        MEMORY_FLUSH_READ_ONLY_HINT,
        MEMORY_FLUSH_APPEND_ONLY_HINT,
        MEMORY_FLUSH_METADATA_HINT,
        `Usually ${SILENT_REPLY_TOKEN} is correct if there is no durable new information.`
    ].join(' ')));
    return {
        softThresholdTokens: normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? MEMORY_FLUSH_SOFT_TOKENS,
        forceFlushTranscriptBytes: parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ?? MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
        reserveTokensFloor: normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ?? MEMORY_FLUSH_RESERVE_TOKENS_FLOOR,
        model: String(defaults?.model || '').trim() || undefined,
        prompt: appendCurrentTimeLine(prompt.replaceAll('YYYY-MM-DD', dateStamp), nowMs, timezone),
        systemPrompt: systemPrompt.replaceAll('YYYY-MM-DD', dateStamp),
        relativePath: `memory/${dateStamp}.md`
    };
};
const isObject = (value)=>Boolean(value && typeof value === 'object' && !Array.isArray(value));
const resolveRawPluginConfig = (raw)=>{
    if (!isObject(raw)) return {};
    const nested = raw?.plugins?.entries?.gigabrain?.config;
    if (isObject(nested)) return nested;
    return raw;
};
const resolveGatewayAuthToken = (raw)=>{
    if (!isObject(raw)) return '';
    const gateway = raw?.gateway;
    if (!isObject(gateway)) return '';
    const auth = gateway?.auth;
    if (!isObject(auth)) return '';
    return String(auth?.token || '').trim();
};
const parseAgentIdFromSessionKey = (sessionKey)=>{
    const parts = String(sessionKey || '').split(':');
    return String(parts[1] || 'shared').trim() || 'shared';
};
const normalizeResolvedScope = (value)=>{
    const scope = String(value || '').trim();
    if (!scope) return '';
    if (scope === 'main') return 'profile:main';
    return scope;
};
const slugifyScopeToken = (value)=>{
    const input = String(value || '').toLowerCase();
    let out = '';
    let lastWasDash = false;
    for (const char of input){
        const code = char.charCodeAt(0);
        const isLower = code >= 97 && code <= 122;
        const isDigit = code >= 48 && code <= 57;
        if (isLower || isDigit) {
            out += char;
            lastWasDash = false;
            continue;
        }
        if (!lastWasDash && out) {
            out += '-';
            lastWasDash = true;
        }
    }
    if (out.endsWith('-')) out = out.slice(0, -1);
    return out.slice(0, 40);
};
const deriveScopeFromWorkspaceDir = (workspaceDir)=>{
    const resolved = String(workspaceDir || '').trim();
    if (!resolved) return '';
    const absolute = path.resolve(resolved);
    const slug = slugifyScopeToken(path.basename(absolute)) || 'workspace';
    const hash = createHash('sha1').update(absolute).digest('hex').slice(0, 8);
    return `project:${slug}:${hash}`;
};
const GIGABRAIN_CONTEXT_RE = /<gigabrain-context>([\s\S]*?)<\/gigabrain-context>/gi;
const QUERY_META_LINE_RE = /^(?:fallback|memories|instruction|entity_mode|conversation info|to send an image back)\s*:/i;
const BOOTSTRAP_INJECTION_RE = /\b(?:you are running a boot check|boot\.md|reply with only:\s*no_reply|a new session was started via \/new or \/reset|session startup sequence|follow boot\.md instructions exactly)\b/i;
const NO_REPLY_ONLY_RE = /^no_reply[.!]?$/i;
const FOLLOWUP_PRONOUN_RE = /\b(?:sie|er|ihn|ihr|her|him|them|diese(?:r|n|m)?|jene(?:r|n|m)?|that person|diese person|jene person)\b/i;
const FOLLOWUP_INTENT_RE = /\b(?:was|what|sag|tell|erz[aä]hl|noch|mehr|else|weiter|weiteres)\b/i;
const ENTITY_FROM_QUERY_RE = /\b(?:wer\s+ist|who\s+is|who\s+was|what\s+do\s+you\s+know\s+about|tell\s+me\s+about|was\s+wei(?:ss|ß)t\s+du\s+über|was\s+weisst\s+du\s+ueber|über|ueber|about)\s+([a-zA-ZÀ-ÖØ-öø-ÿ][a-zA-ZÀ-ÖØ-öø-ÿ0-9'’._-]*(?:\s+[a-zA-ZÀ-ÖØ-öø-ÿ][a-zA-ZÀ-ÖØ-öø-ÿ0-9'’._-]*){0,2})/i;
const ENTITY_STOPWORDS = new Set([
    'sie',
    'er',
    'ihr',
    'ihn',
    'her',
    'him',
    'them',
    'diese',
    'dieser',
    'diesem',
    'jener',
    'jene',
    'jenem',
    'person',
    'about',
    'ueber',
    'über',
    'who',
    'what'
]);
const MAX_QUERY_SCAN_MESSAGES = 200;
const MAX_QUERY_MESSAGE_CHARS = 12000;
const messageToText = (msg)=>{
    if (typeof msg?.content === 'string') return msg.content;
    if (Array.isArray(msg?.content)) {
        return msg.content.map((part)=>typeof part?.text === 'string' ? part.text : '').join('\n');
    }
    return '';
};
const getScannableMessages = (event)=>{
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    if (messages.length <= MAX_QUERY_SCAN_MESSAGES) return messages;
    return messages.slice(-MAX_QUERY_SCAN_MESSAGES);
};
const messageToScannableText = (msg)=>messageToText(msg).slice(0, MAX_QUERY_MESSAGE_CHARS);
const extractContextQuery = (input)=>{
    const text = String(input || '');
    const candidates = [];
    let match;
    while((match = GIGABRAIN_CONTEXT_RE.exec(text)) !== null){
        const block = String(match[1] || '');
        const lines = block.split(/\r?\n/);
        for (const rawLine of lines){
            const line = String(rawLine || '').trim();
            if (!line) continue;
            if (!line.toLowerCase().startsWith('query:')) continue;
            const value = line.slice('query:'.length).trim();
            if (value) candidates.push(value);
        }
    }
    return candidates.length > 0 ? candidates[candidates.length - 1] : '';
};
const sanitizeCandidateQuery = (input)=>{
    let text = String(input || '').trim();
    if (!text) return '';
    for(let i = 0; i < 3; i += 1){
        const contextQuery = extractContextQuery(text);
        if (!contextQuery) break;
        if (contextQuery === text) break;
        text = contextQuery;
    }
    const lines = text.split(/\r?\n/).map((line)=>String(line || '').trim()).filter(Boolean);
    const cleaned = [];
    for (const line of lines){
        if (line.startsWith('```')) continue;
        if (/^[-*]\s*\[.+\]\s*\(.+\)\s*/.test(line)) continue;
        if (QUERY_META_LINE_RE.test(line)) continue;
        if (/^\{.*\}$/.test(line)) continue;
        if (/^\[[^\]]+\]\s*$/.test(line)) continue;
        cleaned.push(line);
    }
    text = cleaned.length > 0 ? cleaned.join(' ') : text;
    text = text.replace(/^\[[^\]]+\]\s*/, '').trim();
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 600) text = text.slice(0, 600).trim();
    if (!text) return '';
    if (NO_REPLY_ONLY_RE.test(text)) return '';
    if (BOOTSTRAP_INJECTION_RE.test(text)) return '';
    return text;
};
const resolveScopeForEvent = (event)=>{
    const explicit = normalizeResolvedScope(String(event?.scope || event?.agentId || '').trim());
    if (explicit) return explicit;
    const sessionKey = String(event?.sessionKey || event?.meta?.sessionKey || '').trim();
    if (sessionKey) {
        const parsedAgentId = normalizeResolvedScope(parseAgentIdFromSessionKey(sessionKey));
        if (parsedAgentId && parsedAgentId !== 'shared') return parsedAgentId;
    }
    const workspaceScope = deriveScopeFromWorkspaceDir(String(event?.workspaceDir || '').trim());
    if (workspaceScope) return workspaceScope;
    if (!sessionKey) return 'shared';
    return normalizeResolvedScope(parseAgentIdFromSessionKey(sessionKey));
};
const mergeEventWithCtx = (event, ctx)=>{
    const merged = {
        ...isObject(event) ? event : {}
    };
    const context = isObject(ctx) ? ctx : {};
    const sessionKey = String(merged?.sessionKey || merged?.meta?.sessionKey || merged?.metadata?.sessionKey || context?.sessionKey || '').trim();
    const agentId = String(merged?.agentId || context?.agentId || '').trim();
    if (agentId && !String(merged.agentId || '').trim()) merged.agentId = agentId;
    if (sessionKey && !String(merged.sessionKey || '').trim()) merged.sessionKey = sessionKey;
    if (sessionKey) {
        const meta = isObject(merged.meta) ? merged.meta : {};
        if (!String(meta.sessionKey || '').trim()) {
            merged.meta = {
                ...meta,
                sessionKey
            };
        }
    }
    if (!String(merged.workspaceDir || '').trim() && String(context?.workspaceDir || '').trim()) {
        merged.workspaceDir = String(context.workspaceDir).trim();
    }
    if (!String(merged.trigger || '').trim() && String(context?.trigger || '').trim()) {
        merged.trigger = String(context.trigger).trim();
    }
    if (!String(merged.channelId || '').trim() && String(context?.channelId || '').trim()) {
        merged.channelId = String(context.channelId).trim();
    }
    return merged;
};
const extractUserQuery = (event)=>{
    const messages = getScannableMessages(event);
    for(let i = messages.length - 1; i >= 0; i -= 1){
        const msg = messages[i];
        const role = String(msg?.role || '').toLowerCase();
        if (role !== 'user') continue;
        const content = messageToScannableText(msg);
        const sanitized = sanitizeCandidateQuery(content);
        if (sanitized) return sanitized;
    }
    return sanitizeCandidateQuery(String(event?.prompt || ''));
};
const extractEntityHintFromQuery = (query)=>{
    const text = String(query || '').trim();
    if (!text) return '';
    const match = text.match(ENTITY_FROM_QUERY_RE);
    if (!match?.[1]) return '';
    const candidate = String(match[1] || '').trim().replace(/[?!.,;:]+$/g, '').replace(/\s+/g, ' ');
    if (!candidate) return '';
    const normalized = candidate.toLowerCase();
    if (ENTITY_STOPWORDS.has(normalized)) return '';
    return candidate;
};
const isLikelyEntityFollowup = (query)=>{
    const text = String(query || '').trim();
    if (!text) return false;
    return FOLLOWUP_PRONOUN_RE.test(text) && FOLLOWUP_INTENT_RE.test(text);
};
const normalizedQueryKey = (value)=>String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const findPreviousEntityHint = (messages, currentQuery)=>{
    const list = Array.isArray(messages) ? messages.slice(-MAX_QUERY_SCAN_MESSAGES) : [];
    let skippedCurrent = false;
    for(let i = list.length - 1; i >= 0; i -= 1){
        const msg = list[i];
        if (String(msg?.role || '').toLowerCase() !== 'user') continue;
        const candidate = sanitizeCandidateQuery(messageToScannableText(msg));
        if (!candidate) continue;
        if (!skippedCurrent && normalizedQueryKey(candidate) === normalizedQueryKey(currentQuery)) {
            skippedCurrent = true;
            continue;
        }
        const hint = extractEntityHintFromQuery(candidate);
        if (hint) return hint;
    }
    return '';
};
const enrichQueryWithEntityContext = (query, messages)=>{
    const base = String(query || '').trim();
    if (!base) return '';
    if (extractEntityHintFromQuery(base)) return base;
    if (!isLikelyEntityFollowup(base)) return base;
    const hint = findPreviousEntityHint(messages, base);
    if (!hint) return base;
    const lowered = base.toLowerCase();
    if (lowered.includes(hint.toLowerCase())) return base;
    return `${base} ${hint}`.trim();
};
const extractCapturePayload = (event)=>{
    const output = String(event?.output || event?.result || event?.response || event?.final || '');
    return {
        scope: resolveScopeForEvent(event),
        agentId: String(event?.agentId || parseAgentIdFromSessionKey(String(event?.sessionKey || ''))),
        sessionKey: String(event?.sessionKey || ''),
        text: output,
        prompt: String(event?.prompt || ''),
        messages: Array.isArray(event?.messages) ? event.messages : []
    };
};
const resolveSessionKey = (event)=>String(event?.sessionKey || event?.meta?.sessionKey || event?.metadata?.sessionKey || '').trim();
const buildSessionPreludeInjection = (content)=>{
    const lines = [
        '<gigabrain-session-brief>'
    ];
    lines.push('instruction: This is the latest scope-specific Gigabrain session prelude. Use it silently as grounding at the start of the session.');
    lines.push('instruction: Prefer this briefing and later Gigabrain recall context over ad-hoc verification unless the user explicitly asks for exact provenance.');
    for (const rawLine of String(content || '').split(/\r?\n/)){
        const line = String(rawLine || '').trim();
        if (!line) continue;
        lines.push(line);
    }
    lines.push('</gigabrain-session-brief>');
    return `${lines.join('\n')}\n`;
};
const buildScopedSessionPreludeFromMemories = (db, scope)=>{
    const rows = db.prepare(`
    SELECT type, content, confidence, value_score
    FROM memory_current
    WHERE status = 'active' AND scope = ?
    ORDER BY COALESCE(value_score, 0) DESC, COALESCE(confidence, 0) DESC, updated_at DESC
    LIMIT 6
  `).all(scope);
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const lines = [
        'Session Brief',
        '',
        `High-confidence scope-specific grounding for ${scope}.`,
        ''
    ];
    for (const row of rows){
        const content = String(row?.content || '').replace(/\s+/g, ' ').trim();
        if (!content) continue;
        const type = String(row?.type || 'CONTEXT').trim() || 'CONTEXT';
        lines.push(`- [${type}] ${content}`);
    }
    return lines.join('\n').trim();
};
const getScopedSessionPreludeContent = (db, scope)=>{
    const normalizedScope = normalizeResolvedScope(scope || 'shared') || 'shared';
    const candidates = normalizedScope === 'shared' ? [
        {
            subjectType: 'global',
            subjectId: 'global'
        }
    ] : [
        {
            subjectType: 'scope',
            subjectId: normalizedScope
        },
        ...normalizedScope === 'profile:main' ? [
            {
                subjectType: 'profile',
                subjectId: 'main'
            }
        ] : []
    ];
    for (const candidate of candidates){
        const synthesis = getSynthesis(db, {
            kind: 'session_brief',
            subjectType: candidate.subjectType,
            subjectId: candidate.subjectId
        });
        const content = String(synthesis?.content || '').trim();
        if (content) return content;
    }
    if (normalizedScope === 'shared') return '';
    return buildScopedSessionPreludeFromMemories(db, normalizedScope);
};
const BRIEFED_SESSION_LIMIT = 2048;
const BRIEFED_SESSION_RETAIN = 1536;
const hasSessionPrelude = (cache, sessionKey)=>{
    const key = String(sessionKey || '').trim();
    if (!key) return false;
    const existing = cache.get(key);
    if (!Number.isFinite(existing)) return false;
    cache.set(key, Date.now());
    return true;
};
const markSessionBriefed = (cache, sessionKey)=>{
    const key = String(sessionKey || '').trim();
    if (!key) return;
    cache.set(key, Date.now());
    if (cache.size <= BRIEFED_SESSION_LIMIT) return;
    const survivors = Array.from(cache.entries()).sort((a, b)=>Number(b[1] || 0) - Number(a[1] || 0)).slice(0, BRIEFED_SESSION_RETAIN);
    cache.clear();
    for (const [survivorKey, timestamp] of survivors){
        cache.set(survivorKey, timestamp);
    }
};
const withDb = (dbPath, config, fn)=>{
    const db = openDatabase(dbPath);
    let shouldClose = true;
    const close = ()=>{
        if (!shouldClose) return;
        shouldClose = false;
        db.close();
    };
    try {
        ensureProjectionStore(db);
        ensureEventStore(db);
        ensureNativeStore(db);
        ensurePersonStore(db);
        ensureWorldModelStore(db);
        const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
        if (Number(count) === 0) {
            materializeProjectionFromMemories(db);
        }
        ensureWorldModelReady({
            db,
            config
        });
        const result = fn(db);
        if (result && typeof result.then === 'function') {
            return result.finally(close);
        }
        close();
        return result;
    } catch (err) {
        close();
        throw err;
    }
};
const shouldSkipRecall = (query)=>{
    const text = String(query || '').trim().toLowerCase();
    if (!text) return true;
    if (text.startsWith('automation:')) return true;
    if (text.includes('<memory_note')) return true;
    if (NO_REPLY_ONLY_RE.test(text)) return true;
    if (BOOTSTRAP_INJECTION_RE.test(text)) return true;
    return false;
};
const gigabrainPlugin = {
    id: 'gigabrain',
    name: 'Gigabrain',
    description: 'Gigabrain v3 lean memory engine (event timeline + current projection)',
    kind: 'memory',
    configSchema: V3_CONFIG_SCHEMA,
    register (api) {
        const logger = api.logger || {};
        const rawConfig = resolveRawPluginConfig(api.config);
        const briefedSessions = new Map();
        let config;
        try {
            config = normalizeConfig(rawConfig, {
                workspaceRoot: process.cwd()
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error?.(`[gigabrain] invalid v3 config: ${message}`);
            throw err;
        }
        if (config.enabled === false) {
            logger.info?.('[gigabrain] disabled by config');
            return;
        }
        const dbPath = path.resolve(config.runtime.paths.registryPath);
        fs.mkdirSync(path.dirname(dbPath), {
            recursive: true
        });
        logger.info?.(`[gigabrain] v3 startup db=${dbPath}`);
        api.registerMemoryCapability?.({
            runtime: gigabrainMemoryRuntime,
            flushPlanResolver: (params)=>buildGigabrainMemoryFlushPlan({
                    config,
                    params
                })
        });
        if (!api.registerMemoryCapability && api.registerMemoryRuntime) {
            api.registerMemoryRuntime(gigabrainMemoryRuntime);
        }
        api.registerCli?.(registerGigabrainMemoryCli, {
            commands: [
                'memory'
            ],
            descriptors: gigabrainMemoryCliDescriptors
        });
        withDb(dbPath, config, ()=>undefined);
        withDb(dbPath, config, (db)=>{
            if (config.native.enabled === false) return;
            const nativeSync = syncNativeMemory({
                db,
                config,
                dryRun: false
            });
            const nativePromotion = promoteNativeChunks({
                db,
                config,
                sourcePaths: nativeSync.changed_sources || [],
                dryRun: false
            });
            const nativeChanged = Number(nativeSync.changed_files || 0) > 0 || Number(nativeSync.inserted_chunks || 0) > 0 || Number(nativeSync.removed_sources || 0) > 0 || Number(nativePromotion.promoted_inserted || 0) > 0 || Number(nativePromotion.linked_existing || 0) > 0;
            if (nativeChanged) {
                rebuildEntityMentions(db);
            }
            if (config.worldModel?.enabled !== false) {
                const worldModel = nativeChanged ? rebuildWorldModel({
                    db,
                    config
                }) : ensureWorldModelReady({
                    db,
                    config,
                    rebuildIfEmpty: false
                });
                logger.info?.(`[gigabrain] world model entities=${worldModel.counts.entities || 0} beliefs=${worldModel.counts.beliefs || 0} syntheses=${worldModel.counts.syntheses || 0}`);
            }
            logger.info?.(`[gigabrain] native sync changed=${nativeSync.changed_files} inserted=${nativeSync.inserted_chunks} promoted=${nativePromotion.promoted_inserted} linked=${nativePromotion.linked_existing}`);
        });
        if (api.registerHttpHandler || api.registerHttpRoute) {
            const token = String(rawConfig?.runtime?.apiToken || resolveGatewayAuthToken(api.config) || process.env.GB_UI_TOKEN || '').trim();
            const allowNoAuth = [
                '1',
                'true',
                'yes'
            ].includes(String(process.env.GB_ALLOW_NO_AUTH || '').trim().toLowerCase());
            if (!token && !allowNoAuth) {
                logger.warn?.('[gigabrain] HTTP routes disabled: no GB_UI_TOKEN or gateway.auth.token available');
            } else {
                const handler = createMemoryHttpHandler({
                    dbPath,
                    config,
                    logger,
                    token,
                    allowNoAuth
                });
                if (api.registerHttpRoute) {
                    for (const route of GIGABRAIN_HTTP_ROUTES){
                        api.registerHttpRoute({
                            path: route.path,
                            auth: 'gateway',
                            match: route.match,
                            handler: async (req, res)=>{
                                const handled = await handler(req, res);
                                if (!handled && !res.headersSent) {
                                    res.statusCode = 404;
                                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                                    res.end('Not Found');
                                }
                            }
                        });
                    }
                    logger.info?.(`[gigabrain] /gb routes registered via registerHttpRoute (${GIGABRAIN_HTTP_ROUTES.length})`);
                } else if (api.registerHttpHandler) {
                    api.registerHttpHandler(handler);
                    logger.info?.('[gigabrain] /gb routes registered via registerHttpHandler');
                }
            }
        }
        api.on('before_prompt_build', async (event, ctx)=>{
            try {
                const resolvedEvent = mergeEventWithCtx(event, ctx);
                const baseQuery = extractUserQuery(resolvedEvent);
                const messages = Array.isArray(resolvedEvent?.messages) ? resolvedEvent.messages : [];
                const query = enrichQueryWithEntityContext(baseQuery, messages);
                if (shouldSkipRecall(query)) return;
                const scope = resolveScopeForEvent(resolvedEvent);
                const sessionKey = resolveSessionKey(resolvedEvent);
                const { recall, sessionPrelude } = withDb(dbPath, config, (db)=>{
                    const recallStartMs = performance.now();
                    const orchestrated = orchestrateRecall({
                        db,
                        config,
                        query,
                        scope
                    });
                    const recallElapsedMs = Math.round(performance.now() - recallStartMs);
                    const recallChars = String(orchestrated?.injection || '').length;
                    recordRecallLatency({
                        ms: recallElapsedMs,
                        strategy: orchestrated?.strategy || '',
                        chars: recallChars,
                        resultCount: Array.isArray(orchestrated?.results) ? orchestrated.results.length : 0
                    });
                    logger.info?.(`[gigabrain] recall injected ${recallChars} chars in ${recallElapsedMs}ms strategy=${orchestrated?.strategy || 'unknown'}`);
                    const shouldInjectPrelude = Boolean(config?.synthesis?.enabled !== false && config?.synthesis?.briefing?.enabled !== false && config?.synthesis?.briefing?.includeSessionPrelude !== false && sessionKey && !hasSessionPrelude(briefedSessions, sessionKey));
                    if (!shouldInjectPrelude) {
                        return {
                            recall: orchestrated,
                            sessionPrelude: ''
                        };
                    }
                    const sessionPreludeContent = getScopedSessionPreludeContent(db, scope);
                    return {
                        recall: orchestrated,
                        sessionPrelude: sessionPreludeContent ? buildSessionPreludeInjection(sessionPreludeContent) : ''
                    };
                });
                if (!recall?.injection) return;
                const combinedInjection = [
                    sessionPrelude,
                    recall.injection
                ].filter((part)=>String(part || '').trim().length > 0).join('\n\n');
                if (!combinedInjection) return;
                if (sessionKey && sessionPrelude) {
                    markSessionBriefed(briefedSessions, sessionKey);
                }
                logger.info?.(`[gigabrain] recall injected ${recall.injection.length} chars strategy=${recall.strategy || 'unknown'}`);
                return {
                    appendSystemContext: combinedInjection
                };
            } catch (err) {
                logger.warn?.(`[gigabrain] recall hook error: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
        });
        api.on('agent_end', async (event, ctx)=>{
            if (config.capture.enabled === false) return;
            try {
                const resolvedEvent = mergeEventWithCtx(event, ctx);
                const payload = extractCapturePayload(resolvedEvent);
                const runId = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                const result = await withDb(dbPath, config, async (db)=>{
                    const autoCapture = enqueueAutoCaptureEvent({
                        db,
                        config,
                        event: payload,
                        logger,
                        runId
                    });
                    const capture = captureFromEvent({
                        db,
                        config,
                        event: payload,
                        logger,
                        runId,
                        reviewVersion: ''
                    });
                    return {
                        ...capture,
                        auto_capture: autoCapture
                    };
                });
                logger.info?.(`[gigabrain] capture inserted=${result.inserted} queued=${result.queued_review} auto_queue=${result.auto_capture?.queue_reason || 'n/a'}`);
            } catch (err) {
                logger.warn?.(`[gigabrain] capture hook error: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    }
};
export default gigabrainPlugin;
export { deriveScopeFromWorkspaceDir, hasSessionPrelude, markSessionBriefed };
