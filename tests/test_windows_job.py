"""Tests for Windows Job Object kill-on-close cleanup across long-lived tunnels."""
import ctypes as C
from ctypes import wintypes as W
import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from bridge.features.network import access, named_tunnel, ssh_tunnel, tailscale, tunnel as quick_tunnel
from bridge.platforms.windows import job as win_job

ROOT = Path(__file__).resolve().parents[1]
TS_ENTRY = {
    **access.DEFAULTS,
    'id': 'ts',
    'name': '',
    'enabled': True,
    'accessMode': 'tailscale',
    'publicUrl': 'https://computer.example.ts.net',
    'tailscaleNodeId': 'n123',
}
CF_ENTRY = {
    **access.DEFAULTS,
    'id': 'cf',
    'name': 'CF',
    'enabled': True,
    'accessMode': 'cloudflare',
    'publicUrl': 'https://cf.example.com',
}


def _windows_pid_alive(pid):
    kernel = C.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel.OpenProcess.restype = W.HANDLE
    kernel.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
    kernel.WaitForSingleObject.restype = W.DWORD
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.CloseHandle.restype = W.BOOL
    handle = kernel.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
    finally:
        kernel.CloseHandle(handle)


def _kill_pid(pid):
    if pid and pid > 0 and _windows_pid_alive(pid):
        subprocess.run(
            ['taskkill.exe', '/PID', str(pid), '/F'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )


class WindowsJobTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.tmp').mkdir(exist_ok=True)

    def test_bind_kill_on_close_ignores_non_process_or_non_windows(self):
        self.assertIsNone(win_job.bind_kill_on_close(None))
        self.assertIsNone(win_job.bind_kill_on_close(MagicMock()))
        self.assertIsNone(win_job.bind_kill_on_close(SimpleNamespace(_handle=True, pid=True)))
        with patch.object(win_job.os, 'name', 'posix'):
            self.assertIsNone(win_job.bind_kill_on_close(SimpleNamespace(pid=os.getpid())))

    @unittest.skipUnless(os.name == 'nt', 'Windows Job Object')
    def test_job_close_terminates_child_and_grandchild_process_tree(self):
        child_script = (
            'import subprocess, sys, time; '
            'print("READY", flush=True); '
            'sys.stdin.readline(); '
            'g = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(60)"]); '
            'print(g.pid, flush=True); '
            'time.sleep(60)'
        )
        child = subprocess.Popen(
            [sys.executable, '-B', '-c', child_script],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        grandchild_pid = None
        job = None

        def cleanup():
            win_job.close_job(job)
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream:
                    try:
                        stream.close()
                    except OSError:
                        pass
            if grandchild_pid:
                _kill_pid(grandchild_pid)

        self.addCleanup(cleanup)
        self.assertEqual(child.stdout.readline().strip(), 'READY')

        job = win_job.bind_kill_on_close(child)
        self.assertIsNotNone(job)
        child.stdin.write('GO\n')
        child.stdin.flush()

        line = child.stdout.readline().strip()
        self.assertTrue(line.isdigit(), f'expected grandchild pid, got {line!r}')
        grandchild_pid = int(line)

        self.assertIsNone(child.poll())
        self.assertTrue(_windows_pid_alive(grandchild_pid))

        # Closing the job handle without calling child.terminate() simulates gateway termination.
        job.close()
        job.close()  # Idempotent.

        child.wait(timeout=5)
        deadline = time.monotonic() + 3.0
        while _windows_pid_alive(grandchild_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(_windows_pid_alive(grandchild_pid))

    def test_tailscale_tunnel_binds_and_closes_job(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            instance = tailscale.TailscaleTunnel(TS_ENTRY, 8787, folder)
            connected = threading.Event()
            release = threading.Event()
            original = instance.status

            def status(state, message, auth_url=''):
                original(state, message, auth_url)
                if state == 'connected':
                    connected.set()

            instance.status = status

            class Output:
                def __iter__(self):
                    yield 'Available on the internet:\n'
                    release.wait(3)

                def close(self):
                    pass

            proc = MagicMock(stdout=Output())
            proc.poll.side_effect = lambda: None if not release.is_set() else 0
            proc.terminate.side_effect = release.set
            proc.wait.return_value = 0
            fake_job = MagicMock()
            with patch.object(tailscale, 'require_identity'), \
                 patch.object(tailscale, 'executable', return_value='/tailscale'), \
                 patch.object(tailscale, 'command_json', return_value={}), \
                 patch.object(tailscale.subprocess, 'Popen', return_value=proc), \
                 patch.object(tailscale, 'bind_kill_on_close', return_value=fake_job) as bind:
                instance.start()
                self.assertTrue(connected.wait(3))
                instance.close()
            bind.assert_called_once_with(proc)
            fake_job.close.assert_called_once()

    def test_named_tunnel_binds_and_closes_job(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            instance = named_tunnel.NamedTunnel('/fixture/cloudflared', CF_ENTRY, folder, 'token')

            class Output:
                def __iter__(self):
                    yield 'INF Registered tunnel connection connIndex=0\n'
                    instance.stopped.set()

                def close(self):
                    pass

            proc = MagicMock(stdout=Output())
            fake_job = MagicMock()
            with patch.object(named_tunnel.subprocess, 'Popen', return_value=proc), \
                 patch.object(named_tunnel, 'bind_kill_on_close', return_value=fake_job) as bind:
                instance._run()
            bind.assert_called_once_with(proc)
            fake_job.close.assert_called_once()
            self.assertIsNone(instance._job)

    def test_ssh_tunnel_binds_and_closes_job(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder, \
             patch('bridge.features.network.ssh_tunnel.shutil.which', return_value='ssh'):
            instance = ssh_tunnel.SSHTunnel('test', 18787, 8787, folder)

            class Process:
                stderr = io.StringIO('debug1: remote forward success for: listen 127.0.0.1:18787\n')

                def wait(self, **kwargs):
                    instance.stopped.set()
                    return 0

                def poll(self):
                    return 0

            proc = Process()
            fake_job = MagicMock()
            with patch.object(ssh_tunnel.subprocess, 'Popen', return_value=proc), \
                 patch.object(ssh_tunnel, 'bind_kill_on_close', return_value=fake_job) as bind:
                instance._run()
            bind.assert_called_once_with(proc)
            fake_job.close.assert_called_once()
            self.assertIsNone(instance._job)

    def test_quick_tunnel_binds_and_closes_job(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            data = Path(folder)
            exe = data / 'cloudflared'
            exe.touch()
            instance = quick_tunnel.QuickTunnel(exe, 8787, data, MagicMock())
            gate = threading.Event()

            class Output:
                def __iter__(self):
                    yield 'https://fixture.trycloudflare.com\n'
                    yield 'Registered tunnel connection\n'
                    gate.wait(3)

            proc = MagicMock(stdout=Output())
            proc.poll.return_value = None
            proc.terminate.side_effect = gate.set
            fake_job = MagicMock()
            with patch.object(quick_tunnel.subprocess, 'Popen', return_value=proc), \
                 patch.object(quick_tunnel, 'bind_kill_on_close', return_value=fake_job) as bind:
                try:
                    self.assertEqual(instance.start(), 'https://fixture.trycloudflare.com')
                finally:
                    instance.close()
            bind.assert_called_once_with(proc)
            fake_job.close.assert_called_once()
            self.assertIsNone(instance._job)


if __name__ == '__main__':
    unittest.main()
