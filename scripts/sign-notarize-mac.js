#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REQUIRED_NOTARY_ENV = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

function missingReleaseEnv(env = process.env) {
  return REQUIRED_NOTARY_ENV.filter((name) => !String(env[name] || '').trim());
}

function assertReleaseEnv(env = process.env) {
  const missing = missingReleaseEnv(env);
  if (missing.length) {
    throw new Error(
      `Missing required Apple notarization environment variables: ${missing.join(', ')}. ` +
      'Release packaging is fail-closed; use npm run package:mac:dev only for a local unsigned build.'
    );
  }
}

function readCodeSignature(appPath) {
  const result = spawnSync('codesign', ['-dvvv', appPath], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect signed application:\n${output.trim()}`);
  }
  return output;
}

function assertDeveloperIdSignature(output) {
  if (/Signature=adhoc/i.test(output) || /TeamIdentifier=not set/i.test(output)) {
    throw new Error('Release application is still ad-hoc signed; refusing to notarize or publish it.');
  }
  if (!/Authority=Developer ID Application:/i.test(output)) {
    throw new Error('Release application is not signed with a Developer ID Application certificate.');
  }
  if (!/flags=.*\bruntime\b/i.test(output)) {
    throw new Error('Release application is missing Hardened Runtime.');
  }
}

async function main() {
  assertReleaseEnv();
  if (process.argv.includes('--check-env')) {
    console.log('Apple notarization environment is configured.');
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('macOS signing and notarization must run on macOS.');
  }

  const root = path.resolve(__dirname, '..');
  const appPath = path.resolve(process.env.LLMPET_MAC_APP || path.join(root, 'dist', 'LLMPET.app'));
  const dragHelper = path.join(appPath, 'Contents', 'Resources', 'drag-window');
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`Application bundle not found: ${appPath}`);
  }
  if (!fs.existsSync(dragHelper) || !fs.statSync(dragHelper).isFile()) {
    throw new Error(`Native drag helper not found: ${dragHelper}`);
  }

  const { signAsync } = require('@electron/osx-sign');
  const { notarize } = require('@electron/notarize');

  const signOptions = {
    app: appPath,
    platform: 'darwin',
    type: 'distribution',
    binaries: [dragHelper],
  };
  if (process.env.MAC_SIGNING_IDENTITY) {
    signOptions.identity = process.env.MAC_SIGNING_IDENTITY;
  }
  if (process.env.MAC_SIGNING_KEYCHAIN) {
    signOptions.keychain = process.env.MAC_SIGNING_KEYCHAIN;
  }

  console.log('Signing LLMPET with Developer ID and Hardened Runtime...');
  await signAsync(signOptions);
  assertDeveloperIdSignature(readCodeSignature(appPath));

  console.log('Submitting LLMPET to Apple notarization service...');
  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log('Apple notarization accepted and ticket stapled.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_NOTARY_ENV,
  missingReleaseEnv,
  assertDeveloperIdSignature,
};
