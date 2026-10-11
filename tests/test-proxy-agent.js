const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldBypassProxy, getProxyAgentForUrl, clearAgentCache } = require('../proxy/lib/proxy-agent.js');

test('Proxy Agent - shouldBypassProxy rules', async (t) => {
    const origEnv = { ...process.env };

    t.afterEach(() => {
        process.env = { ...origEnv };
        clearAgentCache();
    });

    await t.test('bypasses localhost, 127.0.0.1, and ::1 by default', () => {
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;

        assert.equal(shouldBypassProxy('http://localhost:8080'), true);
        assert.equal(shouldBypassProxy('http://127.0.0.1:4401'), true);
        assert.equal(shouldBypassProxy('https://[::1]:8443'), true);
        assert.equal(shouldBypassProxy('https://api.anthropic.com/v1/messages'), false);
    });

    await t.test('bypasses everything when NO_PROXY is *', () => {
        process.env.NO_PROXY = '*';
        assert.equal(shouldBypassProxy('https://api.openai.com/v1/chat/completions'), true);
        assert.equal(shouldBypassProxy('https://api.anthropic.com'), true);
    });

    await t.test('handles domain suffix and exact match in NO_PROXY', () => {
        process.env.NO_PROXY = 'example.com, .internal.net';

        assert.equal(shouldBypassProxy('https://example.com/api'), true);
        assert.equal(shouldBypassProxy('https://sub.example.com/api'), true);
        assert.equal(shouldBypassProxy('https://deep.sub.internal.net/foo'), true);
        assert.equal(shouldBypassProxy('https://internal.net/foo'), true);
        assert.equal(shouldBypassProxy('https://notexample.com/api'), false);
        assert.equal(shouldBypassProxy('https://api.anthropic.com'), false);
    });

    await t.test('handles port-specific NO_PROXY entries', () => {
        process.env.NO_PROXY = 'api.local:8080';

        assert.equal(shouldBypassProxy('http://api.local:8080/v1'), true);
        assert.equal(shouldBypassProxy('http://api.local:9000/v1'), false);
    });

    await t.test('handles IPv6 bracketed and unbracketed NO_PROXY entries with or without port', () => {
        process.env.NO_PROXY = '[::1]:8443, fe80::1, [2001:db8::1]:9000';

        assert.equal(shouldBypassProxy('https://[::1]:8443/test'), true);
        assert.equal(shouldBypassProxy('https://[::1]:8080/test'), true); // bypassed by default localhost
        assert.equal(shouldBypassProxy('http://[fe80::1]:80/status'), true);
        assert.equal(shouldBypassProxy('https://[2001:db8::1]:9000/test'), true);
        assert.equal(shouldBypassProxy('https://[2001:db8::1]:9001/test'), false);
    });
});

test('Proxy Agent - getProxyAgentForUrl resolution and caching', async (t) => {
    const origEnv = { ...process.env };

    t.afterEach(() => {
        process.env = { ...origEnv };
        clearAgentCache();
    });

    await t.test('returns undefined when no proxy env variables are set', () => {
        delete process.env.HTTP_PROXY;
        delete process.env.http_proxy;
        delete process.env.HTTPS_PROXY;
        delete process.env.https_proxy;
        delete process.env.ALL_PROXY;
        delete process.env.all_proxy;
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;

        const agent = getProxyAgentForUrl('https://api.anthropic.com/v1/messages');
        assert.equal(agent, undefined);
    });

    await t.test('returns SocksProxyAgent for socks5:// URL', () => {
        process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';

        const agent = getProxyAgentForUrl('https://api.anthropic.com/v1/messages');
        assert.ok(agent !== undefined, 'Agent should be defined for socks5 proxy');
        assert.equal(agent.constructor.name, 'SocksProxyAgent');
    });

    await t.test('returns HttpsProxyAgent for http:// proxy with https target', () => {
        process.env.HTTPS_PROXY = 'http://corporate-proxy.local:8080';

        const agent = getProxyAgentForUrl('https://api.openai.com/v1/responses');
        assert.ok(agent !== undefined, 'Agent should be defined for http proxy on https target');
        assert.equal(agent.constructor.name, 'HttpsProxyAgent');
    });

    await t.test('returns HttpProxyAgent for http:// proxy with http target', () => {
        process.env.HTTP_PROXY = 'http://corporate-proxy.local:8080';

        const agent = getProxyAgentForUrl('http://insecure-api.local/v1');
        assert.ok(agent !== undefined, 'Agent should be defined for http proxy on http target');
        assert.equal(agent.constructor.name, 'HttpProxyAgent');
    });

    await t.test('strictly respects HTTPS proxy precedence (does NOT use HTTP_PROXY for HTTPS target)', () => {
        delete process.env.HTTPS_PROXY;
        delete process.env.https_proxy;
        delete process.env.ALL_PROXY;
        delete process.env.all_proxy;
        process.env.HTTP_PROXY = 'http://insecure-proxy.local:8080';

        const agent = getProxyAgentForUrl('https://api.anthropic.com/v1/messages');
        assert.equal(agent, undefined, 'HTTPS targets should not fall back to HTTP_PROXY');
    });

    await t.test('caches and reuses agent instances for identical proxy configuration', () => {
        process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';

        const agent1 = getProxyAgentForUrl('https://api.anthropic.com/v1/messages');
        const agent2 = getProxyAgentForUrl('https://api.openai.com/v1/responses');

        assert.equal(agent1, agent2, 'Should reuse cached agent instance for connection pooling');
    });

    await t.test('clearAgentCache calls destroy on cached agents', () => {
        process.env.HTTPS_PROXY = 'http://corporate-proxy.local:8080';

        const agent = getProxyAgentForUrl('https://api.openai.com/v1/responses');
        assert.ok(agent);

        let destroyed = false;
        const origDestroy = agent.destroy;
        agent.destroy = function(...args) {
            destroyed = true;
            if (origDestroy) origDestroy.apply(this, args);
        };

        clearAgentCache();
        assert.equal(destroyed, true, 'Cached agent destroy method should be called on clearAgentCache');
    });

    await t.test('returns undefined for bypassed destination even when proxy is set', () => {
        process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
        process.env.NO_PROXY = 'googleapis.com';

        const agent = getProxyAgentForUrl('https://daily-cloudcode-pa.googleapis.com');
        assert.equal(agent, undefined, 'Bypassed destination should return undefined agent');
    });
});
