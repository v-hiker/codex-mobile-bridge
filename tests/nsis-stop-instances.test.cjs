'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const script = path.resolve(__dirname, '../desktop/nsis-stop-instances.ps1');

function runHelper(args) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('nsis-stop-instances inspect handles empty and unsafe short roots safely', { skip: process.platform !== 'win32' }, t => {
  const scratch = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const emptyDir = fs.mkdtempSync(path.join(scratch, 'nsis-empty-'));
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

  const empty = runHelper(['-Mode', 'inspect', '-DirsJoined', emptyDir, '-CallerPid', String(process.pid)]);
  assert.equal(empty.status, 0);

  const unsafe = runHelper(['-Mode', 'inspect', '-DirsJoined', 'C:\\;D:\\;\\\\server\\share', '-CallerPid', String(process.pid)]);
  assert.equal(unsafe.status, 0);
});

test('nsis-stop-instances detects and stops processes inside target directory while respecting CallerPid', { skip: process.platform !== 'win32' }, async t => {
  const scratch = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const target = fs.mkdtempSync(path.join(scratch, 'nsis-stop-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));

  const fakeExe = path.join(target, 'Codex Mobile Bridge.exe');
  fs.copyFileSync(process.execPath, fakeExe);

  const sleeper = spawn(fakeExe, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const protectedChild = spawn(fakeExe, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  t.after(() => {
    for (const child of [sleeper, protectedChild]) {
      try { if (child.pid && pidAlive(child.pid)) child.kill('SIGKILL'); } catch {}
    }
  });

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(pidAlive(sleeper.pid), true);
  assert.equal(pidAlive(protectedChild.pid), true);

  // Passing protectedChild.pid as CallerPid proves it and its ancestor are never stopped.
  const inspectProtectedOnly = runHelper([
    '-Mode', 'inspect',
    '-DirsJoined', target,
    '-CallerPid', String(protectedChild.pid),
  ]);
  // sleeper is still under target while protectedChild is exempt -> detects direct lock (10).
  assert.equal(inspectProtectedOnly.status, 10);

  const stopped = runHelper([
    '-Mode', 'stop',
    '-DirsJoined', target,
    '-CallerPid', String(protectedChild.pid),
  ]);
  // sleeper exited, protectedChild remains alive because it is CallerPid; let's check both!
  // Since protectedChild is exempt from Get-LockState, Direct becomes empty -> exit 0!
  assert.equal(stopped.status, 0);
  assert.equal(pidAlive(sleeper.pid), false);
  assert.equal(pidAlive(protectedChild.pid), true);

  // Now stop without exempting protectedChild (pass our own pid as CallerPid):
  const finalStop = runHelper([
    '-Mode', 'stop',
    '-DirsJoined', target,
    '-CallerPid', String(process.pid),
  ]);
  assert.equal(finalStop.status, 0);
  assert.equal(pidAlive(protectedChild.pid), false);

  const inspectAfter = runHelper([
    '-Mode', 'inspect',
    '-DirsJoined', target,
    '-CallerPid', String(process.pid),
  ]);
  assert.equal(inspectAfter.status, 0);
});
