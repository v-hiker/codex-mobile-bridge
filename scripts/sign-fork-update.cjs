'use strict';
// Sign fork release manifests for whatever platform assets exist in the artifact directory.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const { assetName } = require('../desktop/features/updates/updater.cjs');
const { writeChecksums } = require('./release-assets.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PUBLIC_KEY_PATH = path.join(ROOT, 'desktop/features/updates/update-public-key.pem');

const DESKTOP_TARGETS = [
  ['darwin', 'arm64', 'zip'],
  ['darwin', 'arm64', 'dmg'],
  ['darwin', 'x64', 'zip'],
  ['darwin', 'x64', 'dmg'],
  ['win32', 'x64', 'zip'],
  ['win32', 'x64', 'exe'],
  ['linux', 'x64', 'deb'],
  ['linux', 'x64', 'AppImage'],
  ['linux', 'arm64', 'deb'],
  ['linux', 'arm64', 'AppImage'],
];

/** Parse a raw PEM or base64-encoded PEM Ed25519 private key. */
function parseSigningKey(raw) {
  if (!raw || typeof raw !== 'string') {
    throw Error('Signing key is required.');
  }
  const trimmed = raw.trim();
  const decoded = trimmed.startsWith('-----BEGIN')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8').trim();
  const normalized = decoded.replace(/\r\n/g, '\n');
  return createPrivateKey(normalized.endsWith('\n') ? normalized : normalized + '\n');
}

/** Build and verify a signed bridge-update.json payload for present release assets. */
function buildForkManifest({
  version = require('../package.json').version,
  directory,
  notes = '',
  key,
  publicKeyPem = fs.readFileSync(DEFAULT_PUBLIC_KEY_PATH, 'utf8'),
}) {
  if (!directory) throw Error('Artifact directory is required.');
  const privateKey = typeof key === 'string' ? parseSigningKey(key) : key;
  const trustedPem = publicKeyPem.replace(/\r\n/g, '\n');
  const derivedPem = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' })
    .replace(/\r\n/g, '\n');
  if (derivedPem !== trustedPem) {
    throw Error('Signing key does not match desktop/features/updates/update-public-key.pem.');
  }

  const assets = {};
  for (const [platform, arch, format] of DESKTOP_TARGETS) {
    const name = assetName(version, platform, arch, format);
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw Error('Release asset must be a nonempty regular file: ' + name);
    }
    const bytes = fs.readFileSync(file);
    const keyName = `${platform}-${arch}${platform === 'linux' || format !== 'zip' ? '-' + format : ''}`;
    assets[keyName] = {
      name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  if (!Object.keys(assets).length) {
    throw Error(`No supported desktop release assets found in ${directory} for v${version}.`);
  }

  const payload = Buffer.from(
    JSON.stringify({ schema: 1, version, dataFormat: 'bridge-data-v1', notes, assets })
  );
  const signature = sign(null, payload, privateKey);
  if (!verify(null, payload, trustedPem, signature)) {
    throw Error('Self-verification of fork update manifest failed.');
  }
  return JSON.stringify({
    payload: payload.toString('base64'),
    signature: signature.toString('base64'),
  }) + '\n';
}

function parseCliArgs(argv) {
  const args = [...argv];
  let notes = '';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--notes' && i + 1 < args.length) {
      notes = args[++i];
    } else if (args[i] === '--notes-file' && i + 1 < args.length) {
      notes = fs.readFileSync(args[++i], 'utf8');
    } else {
      positional.push(args[i]);
    }
  }
  return { version: positional[0], directory: positional[1], notes };
}

if (require.main === module) {
  const { version, directory, notes } = parseCliArgs(process.argv.slice(2));
  const rawKey = process.env.UPDATE_SIGNING_KEY || process.env.CMB_UPDATE_SIGNING_KEY;
  if (!version || !directory || !rawKey) {
    throw Error('Usage: UPDATE_SIGNING_KEY=<PEM> node scripts/sign-fork-update.cjs <version> <artifact-dir> [--notes text|--notes-file path]');
  }
  const signed = buildForkManifest({ version, directory, notes, key: rawKey });
  fs.writeFileSync(path.join(directory, 'bridge-update.json'), signed);
  writeChecksums(directory);
  console.log(`Signed fork update manifest and checksums for v${version} in ${directory}.`);
}

module.exports = { buildForkManifest, parseSigningKey, DESKTOP_TARGETS };
