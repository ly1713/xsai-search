import { pathToFileURL } from 'node:url';

const HELP = 'node search.mjs --query "需求关键词" [--kind all|skill|mcp|tool|github] [--tool codex] [--page 1] [--page-size 5] [--details] [--base-url https://xsai5.xyz]';
const ALLOWED_ORIGINS = new Set(['https://xsai5.xyz', 'http://192.168.2.7:3080']);
const BOOLEAN_FLAGS = new Set(['details', 'help']);

function parseOptions(args) {
    const options = { kind: 'all', page: '1', 'page-size': '5', 'base-url': 'https://xsai5.xyz' };
    const allowed = new Set(['query', 'kind', 'tool', 'page', 'page-size', 'base-url', 'details', 'help']);
    for (let index = 0; index < args.length;) {
        if (!String(args[index]).startsWith('--')) throw new Error('参数无效：' + HELP);
        const key = args[index].slice(2);
        if (!allowed.has(key)) throw new Error('参数无效：' + HELP);
        if (BOOLEAN_FLAGS.has(key)) { options[key] = true; index += 1; continue; }
        if (!args[index + 1]) throw new Error('参数无效：' + HELP);
        options[key] = args[index + 1];
        index += 2;
    }
    options.query = String(options.query || '').trim();
    if (!options.query || options.query.length > 256) throw new Error('--query 必须为 1～256 字符');
    if (!['all', 'skill', 'mcp', 'tool', 'github'].includes(options.kind)) throw new Error('--kind 参数无效');
    for (const [key, max] of [['page', 10000], ['page-size', 100]]) {
        const value = Number(options[key]);
        if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${key} 参数无效`);
    }
    if (options.tool && !/^[a-z0-9_-]{1,64}$/.test(options.tool)) throw new Error('--tool 参数无效');
    const base = new URL(options['base-url']);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('主站 URL 必须为不含凭据或路径的 HTTP(S) origin');
    if (!ALLOWED_ORIGINS.has(base.origin)) throw new Error('主站 URL 仅允许 https://xsai5.xyz 或开发地址 http://192.168.2.7:3080');
    return { options, base };
}

async function boundedJson(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('目录响应格式无效');
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('目录响应超过 2 MiB，请减小 page-size'); }
            text += decoder.decode(value, { stream: true });
        }
        try { return JSON.parse(text + decoder.decode()); }
        catch { throw new Error('目录响应格式无效'); }
    } finally {
        reader.releaseLock();
    }
}

function recommendationDetails(item) {
    const source = (item.kind === 'github' ? item.project : item.kind === 'tool' ? item.tool : item.plugin) || {};
    const fields = item.kind === 'github'
        ? ['description', 'use_cases', 'usage', 'language', 'category']
        : item.kind === 'tool'
            ? ['description_zh', 'category', 'install_method', 'install_source_url', 'version']
            : ['description_zh', 'usage_zh', 'version', 'upstream_version'];
    const details = Object.fromEntries(fields.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
    for (const key of item.kind === 'github' || item.kind === 'tool' ? ['introduction'] : ['introduction', 'usage_detail']) {
        if (!source[key] || typeof source[key] !== 'object' || Array.isArray(source[key])) continue;
        details[key] = Object.fromEntries(['summary', 'core_usage', 'triggers', 'pros_cons', 'audience']
            .filter(field => typeof source[key][field] === 'string').map(field => [field, source[key][field]]));
    }
    if (item.kind !== 'github' && Array.isArray(source.compatible_tools)) {
        details.compatible_tools = source.compatible_tools.filter(value => typeof value === 'string');
    }
    if (Array.isArray(source.tags)) details.tags = source.tags.filter(value => typeof value === 'string');
    for (const key of ['stars', 'install_count']) {
        if (Number.isSafeInteger(source[key]) && source[key] >= 0) details[key] = source[key];
    }
    return details;
}

function compactItem(item, detailed) {
    const projected = Object.fromEntries(['id', 'kind', 'title', 'summary', 'source_url']
        .map(key => [key, item[key]]));
    projected.matched_terms = Array.isArray(item.matched_terms) ? item.matched_terms : [];
    projected.missing_terms = Array.isArray(item.missing_terms) ? item.missing_terms : [];
    projected.evidence = Array.isArray(item.evidence) ? item.evidence.slice(0, detailed ? 5 : 1) : [];
    projected.installable = item.kind !== 'github' && item.installable === true;
    if (!detailed) return projected;
    return {
        ...projected,
        score: item.score,
        matched_fields: Array.isArray(item.matched_fields) ? item.matched_fields : [],
        details: recommendationDetails(item)
    };
}

function normalizeFilters(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.fromEntries(['kind', 'compatible_tool', 'category', 'requested_kind', 'requested_compatible_tool',
        'inferred_kind', 'inferred_compatible_tool', 'relaxed']
        .filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
}

export async function runSearch(args, fetchCatalog = fetch) {
    const { options, base } = parseOptions(args);
    const url = new URL('/api/catalog/v1/search', base);
    url.searchParams.set('q', options.query);
    url.searchParams.set('kind', options.kind);
    url.searchParams.set('page', options.page);
    url.searchParams.set('page_size', options['page-size']);
    if (options.tool) url.searchParams.set('compatible_tool', options.tool);
    const httpResponse = await fetchCatalog(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!httpResponse.ok) { await httpResponse.body?.cancel(); throw new Error(`目录搜索失败 HTTP ${httpResponse.status}，未执行安装或模型调用`); }
    const result = await boundedJson(httpResponse);
    if (!result || result.mode !== 'lexical' || !Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0
        || !Number.isSafeInteger(result.page) || result.page < 1 || result.page > 10000
        || !Number.isSafeInteger(result.page_size) || result.page_size < 1 || result.page_size > 100) throw new Error('目录响应格式无效');
    const items = result.items.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || !['skill', 'mcp', 'tool', 'github'].includes(item.kind) || typeof item.title !== 'string') throw new Error('目录条目格式无效');
        // CLI 工具与 skill/mcp 一样，是插件中心里可安装的条目（只是装法不同）。
        return compactItem(item, options.details === true);
    });
    const response = { query: options.query, mode: result.mode, total: result.total, page: result.page,
        page_size: result.page_size, has_more: result.page * result.page_size < result.total, items };
    const filters = normalizeFilters(result.filters);
    if (filters) response.filters = filters;
    return response;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.includes('--help')) console.log(HELP);
    else runSearch(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
        console.error(JSON.stringify({ error: error.name === 'TimeoutError' ? '目录搜索超时，请稍后重试' : error.message }));
        process.exitCode = 1;
    });
}
