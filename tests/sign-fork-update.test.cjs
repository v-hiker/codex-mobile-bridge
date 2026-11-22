'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { buildForkManifest, parseSigningKey } = require('../scripts/sign-fork-update.cjs');
const { writeChecksums } = require('../scripts/release-assets.cjs');
const { assetName, manifest } = require('../desktop/features/updates/updater.cjs');

test('fork signer signs Windows ZIP and Setup.exe manifests compatible with updater verification', () => {
  const parent = path.join(__dirname, '../.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'fork-sign-'));
  try {
    const version = '2.2.2-preview.4';
    const keys = generateKeyPairSync('ed25519');
    const pubPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const privPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const zipName = assetName(version, 'win32', 'x64', 'zip');
    const exeName = assetName(version, 'win32', 'x64', 'exe');
    const zipBytes = Buffer.from('fork-zip-fixture');
    const exeBytes = Buffer.from('fork-exe-fixture');
    fs.writeFileSync(path.join(dir, zipName), zipBytes);
    fs.writeFileSync(path.join(dir, exeName), exeBytes);

    // Base64-encoded PEM must parse identically to raw PEM.
    const encodedKey = parseSigningKey(Buffer.from(privPem, 'utf8').toString('base64'));
    const signedText = buildForkManifest({
      version,
      directory: dir,
      notes: 'Fork synced upstream release',
      key: encodedKey,
      publicKeyPem: pubPem,
    });
    fs.writeFileSync(path.join(dir, 'bridge-update.json'), signedText);
    writeChecksums(dir);

    const zipRes = manifest(Buffer.from(signedText), keys.publicKey, {
      current: '2.2.2-preview.3',
      platform: 'win32',
      arch: 'x64',
      format: 'zip',
      expected: version,
      channel: 'preview',
    });
    assert.equal(zipRes.asset.name, zipName);
    assert.equal(zipRes.asset.sha256, createHash('sha256').update(zipBytes).digest('hex'));
    assert.ok(zipRes.asset.url.startsWith('https://github.com/v-hiker/codex-mobile-bridge/releases/download/v2.2.2-preview.4/'));

    const exeRes = manifest(Buffer.from(signedText), keys.publicKey, {
      current: '2.2.2-preview.3',
      platform: 'win32',
      arch: 'x64',
      format: 'exe',
      expected: version,
      intent: 'switch-version',
    });
    assert.equal(exeRes.asset.name, exeName);
    assert.equal(exeRes.manualInstall, true);
    assert.equal(exeRes.asset.sha256, createHash('sha256').update(exeBytes).digest('hex'));

    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
    assert.ok(sums.includes(zipName));
    assert.ok(sums.includes(exeName));
    assert.ok(sums.includes('bridge-update.json'));

    const otherKey = generateKeyPairSync('ed25519').privateKey;
    assert.throws(
      () => buildForkManifest({ version, directory: dir, key: otherKey, publicKeyPem: pubPem }),
      /does not match/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
