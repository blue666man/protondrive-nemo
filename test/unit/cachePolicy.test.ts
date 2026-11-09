import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCachePolicy, isUnder, normalizeRemotePath } from '../../src/cachePolicy';

test('normalizeRemotePath gives one leading slash and no trailing or empty segments', () => {
    assert.equal(normalizeRemotePath('Docs/'), '/Docs');
    assert.equal(normalizeRemotePath(' /a//b/ '), '/a/b');
    assert.equal(normalizeRemotePath('/'), '/');
    assert.equal(normalizeRemotePath(''), '/');
});

test('isUnder matches the folder itself and its descendants only', () => {
    assert.equal(isUnder('/Docs', '/Docs'), true);
    assert.equal(isUnder('/Docs', '/Docs/a/b.txt'), true);
    assert.equal(isUnder('/Docs/', 'Docs/a.txt'), true);
    assert.equal(isUnder('/Docs', '/Docsx/a.txt'), false);
    assert.equal(isUnder('/', '/anything'), true);
});

test('with no allowlist every path is cacheable', () => {
    const policy = createCachePolicy({ cachePaths: [], ephemeralCache: false });
    assert.equal(policy.isCacheable('/a.txt'), true);
    assert.deepEqual(policy.allow, []);
});

test('an allowlist limits caching to the listed folders', () => {
    const policy = createCachePolicy({ cachePaths: ['/Docs', 'Photos/'], ephemeralCache: false });
    assert.deepEqual(policy.allow, ['/Docs', '/Photos']);
    assert.equal(policy.isCacheable('/Docs/a.txt'), true);
    assert.equal(policy.isCacheable('/Photos/2026/b.jpg'), true);
    assert.equal(policy.isCacheable('/Music/c.mp3'), false);
});

test('"/" in the allowlist means everything', () => {
    const policy = createCachePolicy({ cachePaths: ['/'], ephemeralCache: false });
    assert.deepEqual(policy.allow, []);
    assert.equal(policy.isCacheable('/Music/c.mp3'), true);
});

test('ephemeral mode caches nothing, even allowlisted paths', () => {
    const policy = createCachePolicy({ cachePaths: ['/Docs'], ephemeralCache: true });
    assert.equal(policy.ephemeral, true);
    assert.equal(policy.isCacheable('/Docs/a.txt'), false);
});
