'use strict';

let SocksProxyAgent = null;
try {
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch {}

let HttpsProxyAgent = null;
try {
    HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
} catch {}

let HttpProxyAgent = null;
try {
    HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
} catch {}

/**
 * Determines whether a given URL should bypass proxy routing based on localhost or NO_PROXY.
 *
 * @param {string|URL} targetUrl - Target request destination
 * @returns {boolean} True if the request should bypass the outbound proxy
 */
function shouldBypassProxy(targetUrl) {
    try {
        const parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
        const hostname = (parsed.hostname || '').toLowerCase();
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

        if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') {
            return true;
        }

        const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
        if (!noProxy) return false;

        const entries = noProxy.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
        for (const entry of entries) {
            if (entry === '*') return true;

            let entryHost = entry;
            let entryPort = null;

            // Handle [ipv6]:port or [ipv6]
            if (entry.startsWith('[')) {
                const closeBracketIdx = entry.indexOf(']');
                if (closeBracketIdx !== -1) {
                    entryHost = entry.slice(0, closeBracketIdx + 1);
                    const remainder = entry.slice(closeBracketIdx + 1);
                    if (remainder.startsWith(':')) {
                        entryPort = remainder.slice(1);
                    }
                }
            } else if (!entry.includes('::') && entry.includes(':')) {
                // Hostname:port or IPv4:port (single colon)
                const parts = entry.split(':');
                if (parts.length === 2) {
                    entryHost = parts[0];
                    entryPort = parts[1];
                }
            }

            if (entryPort && entryPort !== port) {
                continue;
            }

            // Normalize bracketed vs unbracketed for IPv6 comparison
            const normEntry = entryHost.replace(/^\[|\]$/g, '');
            const normHost = hostname.replace(/^\[|\]$/g, '');

            if (normEntry === normHost) return true;

            // Normalize wildcard prefix, e.g. *.example.com -> .example.com
            let pattern = entryHost;
            if (pattern.startsWith('*.')) {
                pattern = pattern.slice(1);
            } else if (pattern.startsWith('*')) {
                pattern = pattern.slice(1);
            }

            if (pattern.startsWith('.')) {
                if (hostname.endsWith(pattern) || hostname === pattern.slice(1)) return true;
            } else if (hostname === pattern || hostname.endsWith('.' + pattern)) {
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

const agentCache = new Map();

/**
 * Returns an HTTP/HTTPS/SOCKS proxy agent if proxy environment variables are configured and the URL is not bypassed.
 *
 * @param {string|URL} targetUrl - Destination URL
 * @returns {object|undefined} Agent instance or undefined if direct connection
 */
function getProxyAgentForUrl(targetUrl) {
    if (shouldBypassProxy(targetUrl)) {
        return undefined;
    }

    let parsed = null;
    try {
        parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
    } catch {
        return undefined;
    }

    const isHttps = parsed.protocol === 'https:';

    // Standard proxy precedence: HTTPS targets respect HTTPS_PROXY or ALL_PROXY (never HTTP_PROXY)
    const proxyUrl = isHttps
        ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy)
        : (process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);

    if (!proxyUrl) return undefined;

    const cacheKey = `${proxyUrl}|${isHttps ? 'https' : 'http'}`;
    if (agentCache.has(cacheKey)) {
        return agentCache.get(cacheKey);
    }

    let agent = undefined;
    try {
        const proxyProtocol = new URL(proxyUrl).protocol.toLowerCase();

        if (proxyProtocol.startsWith('socks') && SocksProxyAgent) {
            agent = new SocksProxyAgent(proxyUrl, { keepAlive: true });
        } else if (proxyProtocol === 'http:' || proxyProtocol === 'https:') {
            if (isHttps && HttpsProxyAgent) {
                agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
            } else if (!isHttps && HttpProxyAgent) {
                agent = new HttpProxyAgent(proxyUrl, { keepAlive: true });
            }
        }
    } catch (e) {
        console.error('[Proxy Agent] Failed to create proxy agent for URL:', proxyUrl, e.message);
        return undefined;
    }

    if (agent) {
        agentCache.set(cacheKey, agent);
    }
    return agent;
}

/**
 * Convenience helper to merge an outbound proxy agent into request options.
 */
function buildRequestOptions(targetUrl, baseOptions = {}) {
    const agent = getProxyAgentForUrl(targetUrl);
    return {
        ...baseOptions,
        ...(agent ? { agent } : {})
    };
}

function clearAgentCache() {
    for (const agent of agentCache.values()) {
        if (agent && typeof agent.destroy === 'function') {
            try {
                agent.destroy();
            } catch {}
        }
    }
    agentCache.clear();
}

module.exports = {
    shouldBypassProxy,
    getProxyAgentForUrl,
    buildRequestOptions,
    clearAgentCache
};
