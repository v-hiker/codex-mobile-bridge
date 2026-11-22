import json
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
(ROOT / '.tmp').mkdir(exist_ok=True)

from bridge.clients.codex.desktop_stdio import DesktopStdio
from bridge.clients.codex.app_server import AppServerUnavailable, AppServerUnknownResult, AppServerRequestNotSent
from bridge.clients.codex.desktop_runtime_host import _forward_input
from bridge.clients.codex.desktop_runtime_windows import MetadataClient
from bridge.clients.codex import desktop_runtime_windows as windows_runtime
from bridge.clients.local_rpc import LocalRequestNotSent
from bridge.features.sessions.create import DeleteRejected


class WindowsAuxiliaryCommandTests(unittest.TestCase):
    def test_auxiliary_commands_wait_and_preserve_native_exit_status_and_streams(self):
        home = Path('.tmp/desktop-auxiliary-home').resolve()
        config = {'version': 1, 'home': str(home), 'launcher': sys.executable,
                  'cli': 'native.exe', 'sandboxFamily': 'OpenAI.Codex_fixture'}
        configuration = windows_runtime.directory(home) / 'settings.json'
        env = {'CMB_CODEX_DESKTOP_CONFIGURATION': str(configuration), 'CODEX_HOME': str(home)}
        with patch.dict(sys.modules, {'msvcrt': SimpleNamespace(setmode=Mock())}), \
             patch.object(windows_runtime, '_read', return_value=config), \
             patch.object(windows_runtime.os, 'O_BINARY', 0, create=True), \
             patch.object(windows_runtime.sys, 'stdin', Mock()), \
             patch.object(windows_runtime.sys, 'stdout', Mock()), \
             patch.dict(os.environ, env, clear=True), \
             patch.object(windows_runtime.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
             patch.object(windows_runtime.subprocess, 'call', return_value=23) as call, \
             patch.object(windows_runtime.os, 'execve', side_effect=AssertionError('Windows CRT overlay')), \
             patch.object(windows_runtime, 'process_identity', side_effect=AssertionError('not a writer')):
            for args in (['--version'], ['app-server', '--print-startup-config']):
                with self.subTest(arguments=args):
                    self.assertEqual(windows_runtime.run(str(configuration), args), 23)
                    call.assert_called_with(['native.exe', *args],
                        env={'CODEX_HOME': str(home), 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY': 'OpenAI.Codex_fixture'},
                        stdin=windows_runtime.sys.stdin, stdout=windows_runtime.sys.stdout,
                        stderr=windows_runtime.sys.stderr,
                        creationflags=0x08000000)

    def test_non_owner_or_external_home_caller_passes_through_and_rewrites_cli_path(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            home = Path(folder) / 'home'
            other_home = Path(folder) / 'other-home'
            cli = Path(folder) / 'native.exe'
            configuration = windows_runtime.directory(home) / 'settings.json'
            config = {'version': 1, 'home': str(home), 'launcher': sys.executable,
                      'application': 'ChatGPT.exe',
                      'cli': str(cli), 'sandboxFamily': 'OpenAI.Codex_fixture'}
            args = ['app-server', '--listen', 'stdio://']
            scenarios = (
                ('non-owner', {'CODEX_HOME': str(home), 'CODEX_CLI_PATH': sys.executable,
                               'CMB_CODEX_DESKTOP_CONFIGURATION': str(configuration)},
                 ValueError('Desktop runtime parent is not the selected App')),
                ('other-home', {'CODEX_HOME': str(other_home), 'CODEX_CLI_PATH': sys.executable,
                                'CMB_CODEX_DESKTOP_CONFIGURATION': str(configuration)}, None),
                ('other-sqlite', {'CODEX_HOME': str(home), 'CODEX_SQLITE_HOME': str(other_home),
                                  'CODEX_CLI_PATH': sys.executable,
                                  'CMB_CODEX_DESKTOP_CONFIGURATION': str(configuration)}, None),
            )
            for label, source_env, owner_error in scenarios:
                with self.subTest(case=label):
                    expected_env = {k: v for k, v in source_env.items() if k != 'CMB_CODEX_DESKTOP_CONFIGURATION'}
                    expected_env['CODEX_CLI_PATH'] = str(cli)
                    expected_env['CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'] = 'OpenAI.Codex_fixture'
                    owner_patch = (patch('bridge.clients.codex.desktop_runtime.desktop_owner', side_effect=owner_error)
                                   if owner_error else patch('bridge.clients.codex.desktop_runtime.desktop_owner'))
                    stdin_mock, stdout_mock = Mock(), Mock()
                    with patch.dict(sys.modules, {'msvcrt': SimpleNamespace(setmode=Mock())}), \
                         patch.object(windows_runtime, '_read', return_value=config), \
                         patch.object(windows_runtime.os, 'O_BINARY', 0, create=True), \
                         patch.object(windows_runtime.sys, 'stdin', stdin_mock), \
                         patch.object(windows_runtime.sys, 'stdout', stdout_mock), \
                         patch.dict(os.environ, source_env, clear=True), \
                         patch.object(windows_runtime.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
                         patch.object(windows_runtime.subprocess, 'call', return_value=19) as call, \
                         patch.object(windows_runtime, 'process_identity', return_value={'pid': 99, 'image': 'node_repl.exe'}), \
                         patch.object(windows_runtime, 'exclusive_lock') as lock, \
                         patch('bridge.clients.codex.desktop_host.serve') as hosted_serve, \
                         owner_patch:
                        self.assertEqual(windows_runtime.run(str(configuration), args), 19)
                        call.assert_called_once_with([str(cli), *args],
                            env=expected_env,
                            stdin=stdin_mock, stdout=stdout_mock,
                            stderr=windows_runtime.sys.stderr, creationflags=0x08000000)
                    lock.assert_not_called()
                    hosted_serve.assert_not_called()

    def test_primary_parent_with_auxiliary_client_info_uses_stdio_passthrough(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            home = Path(folder) / 'home'
            cli = Path(folder) / 'native.exe'
            configuration = windows_runtime.directory(home) / 'settings.json'
            config = {'version': 1, 'home': str(home), 'launcher': sys.executable,
                      'application': 'ChatGPT.exe',
                      'cli': str(cli), 'sandboxFamily': 'OpenAI.Codex_fixture'}
            first = json.dumps({'id': 1, 'method': 'initialize',
                                'params': {'clientInfo': {'name': 'codex-browser-use'}}}).encode() + b'\n'
            second = b'{"id":2,"method":"thread/list"}\n'
            written = bytearray()
            closed = threading.Event()

            class Writer:
                def write(self, data):
                    written.extend(data)
                    return len(data)
                def close(self):
                    closed.set()

            child = Mock(stdin=Writer())
            child.wait.return_value = 0
            stdin = SimpleNamespace(fileno=lambda: 0, buffer=io.BytesIO(first + second))
            env = {'CMB_CODEX_DESKTOP_CONFIGURATION': str(configuration),
                   'CODEX_HOME': str(home), 'CODEX_CLI_PATH': sys.executable}
            with patch.dict(sys.modules, {'msvcrt': SimpleNamespace(setmode=Mock())}), \
                 patch.object(windows_runtime, '_read', return_value=config), \
                 patch.object(windows_runtime.os, 'O_BINARY', 0, create=True), \
                 patch.object(windows_runtime.sys, 'stdin', stdin), \
                 patch.object(windows_runtime.sys, 'stdout', Mock(fileno=lambda: 1)), \
                 patch.dict(os.environ, env, clear=True), \
                 patch.object(windows_runtime.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
                 patch.object(windows_runtime.subprocess, 'Popen', return_value=child) as popen, \
                 patch.object(windows_runtime, 'process_identity', return_value={'pid': 10}), \
                 patch('bridge.clients.codex.desktop_runtime.desktop_owner', return_value=({'pid': 10}, None)), \
                 patch.object(windows_runtime, 'exclusive_lock') as lock, \
                 patch('bridge.clients.codex.desktop_host.serve') as hosted_serve:
                self.assertEqual(windows_runtime.run(str(configuration), ['app-server', '--listen', 'stdio://']), 0)
            self.assertTrue(closed.wait(2))
            self.assertEqual(bytes(written), first + second)
            self.assertEqual(popen.call_args.kwargs['env']['CODEX_CLI_PATH'], str(cli))
            self.assertNotIn('CMB_CODEX_DESKTOP_CONFIGURATION', popen.call_args.kwargs['env'])
            lock.assert_not_called()
            hosted_serve.assert_not_called()

    def test_run_cli_passthrough_forwards_verified_cua_repl_without_config_env(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            home = Path(folder) / 'home'
            cli = Path(folder) / 'codex.exe'
            cli.write_bytes(b'MZ-fixture')
            settings_path = windows_runtime.directory(home) / 'settings.json'
            settings_path.parent.mkdir(parents=True)
            settings_path.touch()
            config = {'version': 1, 'home': str(home), 'launcher': sys.executable,
                      'cli': str(cli), 'sandboxFamily': 'OpenAI.Codex_fixture'}
            cases = (
                ('with-env-cli-path', {'CODEX_HOME': str(home), 'CODEX_CLI_PATH': sys.executable},
                 ['app-server', '--listen', 'stdio://']),
                ('without-env-cli-path', {'CODEX_HOME': str(home)},
                 ['-c', 'features.foo=true', 'app-server']),
                ('version-flag', {'CODEX_HOME': str(home)}, ['--version']),
            )
            for label, env, args in cases:
                with self.subTest(case=label):
                    expected_env = dict(env)
                    if 'CODEX_CLI_PATH' in expected_env:
                        expected_env['CODEX_CLI_PATH'] = str(cli)
                    expected_env['CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY'] = 'OpenAI.Codex_fixture'
                    with patch.dict(os.environ, env, clear=True), \
                         patch.object(windows_runtime.Path, 'home', return_value=Path(folder) / 'user'), \
                         patch.object(windows_runtime, '_read', return_value=config), \
                         patch.object(windows_runtime.subprocess, 'CREATE_NO_WINDOW', 0x08000000, create=True), \
                         patch.object(windows_runtime.subprocess, 'call', return_value=17) as call, \
                         patch.object(windows_runtime, 'exclusive_lock') as lock:
                        self.assertEqual(windows_runtime.run_cli_passthrough(args), 17)
                    call.assert_called_once_with([str(cli), *args],
                        env=expected_env,
                        stdin=windows_runtime.sys.stdin, stdout=windows_runtime.sys.stdout,
                        stderr=windows_runtime.sys.stderr, creationflags=0x08000000)
                    lock.assert_not_called()
                    self.assertFalse((windows_runtime.directory(home) / 'active.json').exists())

    def test_run_cli_passthrough_rejects_unverified_or_non_cli_invocations(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as folder:
            home = Path(folder) / 'home'
            cli = Path(folder) / 'codex.exe'
            cli.write_bytes(b'MZ-fixture')
            settings_path = windows_runtime.directory(home) / 'settings.json'
            settings_path.parent.mkdir(parents=True)
            settings_path.touch()
            valid = {'version': 1, 'home': str(home), 'launcher': sys.executable, 'cli': str(cli)}
            with patch.dict(os.environ, {'CODEX_HOME': str(home)}, clear=True), \
                 patch.object(windows_runtime.Path, 'home', return_value=Path(folder) / 'user'), \
                 patch.object(windows_runtime.subprocess, 'call') as call:
                self.assertIsNone(windows_runtime.run_cli_passthrough([]))
                with patch.object(windows_runtime, '_read', return_value=valid):
                    self.assertIsNone(windows_runtime.run_cli_passthrough(['unknown-action', '--data-dir', 'x']))
                for bad in (
                    {**valid, 'launcher': str(Path(folder) / 'other-gateway.exe')},
                    {**valid, 'version': 2},
                    {**valid, 'cli': sys.executable},
                    {**valid, 'cli': str(Path(folder) / 'missing.exe')},
                    {**valid, 'home': str(Path(folder) / 'other-home')},
                ):
                    with patch.object(windows_runtime, '_read', return_value=bad):
                        self.assertIsNone(windows_runtime.run_cli_passthrough(['app-server']))
                with patch.object(windows_runtime, '_read', side_effect=ValueError('security denied')):
                    self.assertIsNone(windows_runtime.run_cli_passthrough(['app-server']))
            call.assert_not_called()

    def test_desktop_entrypoint_routes_windows_auxiliary_cli_before_argparse(self):
        import runpy
        with patch.object(sys, 'platform', 'win32'), \
             patch.object(sys, 'argv', ['desktop.py', 'app-server', '--listen', 'stdio://']), \
             patch.dict(os.environ, {}, clear=True), \
             patch.object(windows_runtime, 'run_cli_passthrough', return_value=17) as passthrough:
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(ROOT / 'desktop.py'), run_name='__main__')
        self.assertEqual(exited.exception.code, 17)
        passthrough.assert_called_once_with(['app-server', '--listen', 'stdio://'])


class DesktopStdioTests(unittest.TestCase):
    def setUp(self):
        self.writes, self.app, self.initialized = [], [], []
        self.changed = threading.Event()
        def write(data):
            self.writes.append(json.loads(data)); self.changed.set()
        self.router = DesktopStdio(write, self.app.append, self.initialized.append)
        self.addCleanup(self.router.close)

    def ready(self):
        self.router.from_app({'method': 'initialize', 'id': 1, 'params': {'clientInfo': {'name': 'Codex Desktop'}}})
        self.router.from_native({'id': self.writes[-1]['id'], 'result': {'codexHome': 'home'}})
        self.assertEqual(self.app, [{'id': 1, 'result': {'codexHome': 'home'}}])
        self.assertTrue(self.router.ready)
        self.router.from_app({'method': 'initialized'})
        self.assertTrue(self.router.ready)
        self.assertEqual(self.initialized, [{'codexHome': 'home'}])

    def test_desktop_without_initialized_notification_can_use_metadata_after_handshake(self):
        self.router.from_app({'method': 'initialize', 'id': 1, 'params': {'clientInfo': {'name': 'Codex Desktop'}}})
        with self.assertRaises(AppServerRequestNotSent): self.router.request_packet('thread/list', {})
        self.router.from_native({'id': self.writes[-1]['id'], 'result': {'codexHome': 'home'}})
        self.changed.clear()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.router.request_packet, 'thread/list', {})
            self.assertTrue(self.changed.wait(1))
            self.router.from_native({'id': self.writes[-1]['id'], 'result': {'data': []}})
            self.assertEqual(pending.result(1)['result'], {'data': []})
        self.assertEqual(self.initialized, [{'codexHome': 'home'}])

    def test_rejected_or_unverified_handshake_never_marks_ready(self):
        self.router.from_app({'method': 'initialize', 'id': 1, 'params': {}})
        self.router.from_native({'id': self.writes[-1]['id'], 'error': {'code': -32600, 'message': 'rejected'}})
        self.assertFalse(self.router.ready)
        self.assertFalse(self.initialized)
        self.router.from_app({'method': 'initialize', 'id': 2, 'params': {}})
        self.router.initialized = Mock(side_effect=ValueError('owner changed'))
        with self.assertRaisesRegex(ValueError, 'owner changed'):
            self.router.from_native({'id': self.writes[-1]['id'], 'result': {'codexHome': 'other'}})
        self.assertFalse(self.router.ready)

    def test_only_app_initializes_and_bridge_cannot_execute_turns(self):
        with self.assertRaises(AppServerUnavailable): self.router.request_packet('thread/read', {})
        self.ready()
        with self.assertRaises(AppServerRequestNotSent): self.router.request_packet('turn/start', {})
        with self.assertRaises(AppServerRequestNotSent): self.router.request_packet('initialize', {})
        self.assertEqual(len(self.writes), 2)

    def test_app_requests_and_native_approvals_keep_their_original_ids(self):
        self.ready()
        self.router.from_app({'id': 1, 'method': 'thread/read', 'params': {'threadId': 'app-thread'}})
        outbound = self.writes[-1]['id']
        approval = {'id': outbound, 'method': 'item/commandExecution/requestApproval', 'params': {}}
        self.router.from_native(approval)
        self.router.from_app({'id': outbound, 'result': {'decision': 'decline'}})
        self.assertEqual(self.writes[-1], {'id': outbound, 'result': {'decision': 'decline'}})
        self.router.from_native({'id': outbound, 'result': {'thread': 'app-thread'}})
        self.assertEqual(self.app[-2:], [approval, {'id': 1, 'result': {'thread': 'app-thread'}}])

    def test_bridge_reply_is_private_and_notifications_still_reach_app(self):
        self.ready(); self.changed.clear()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.router.request_packet, 'thread/fork', {'threadId': 'parent'})
            self.assertTrue(self.changed.wait(1))
            identifier = self.writes[-1]['id']
            notification = {'method': 'thread/started', 'params': {'thread': {'id': 'child'}}}
            self.router.from_native(notification)
            self.router.from_native({'id': identifier, 'result': {'thread': {'id': 'child'}}})
            self.assertEqual(pending.result(1)['result'], {'thread': {'id': 'child'}})
        self.assertEqual(self.app[-1], notification)
        self.assertEqual(len(self.app), 2)

    def test_timeout_never_replays_or_delivers_late_reply_to_app(self):
        self.ready()
        with self.assertRaises(AppServerUnknownResult): self.router.request_packet('thread/fork', {}, timeout=.001)
        self.router.from_native({'id': self.writes[-1]['id'], 'result': {'thread': {'id': 'late'}}})
        self.assertEqual(len(self.writes), 3)
        self.assertEqual(len(self.app), 1)

    def test_close_wakes_inflight_bridge_without_replaying(self):
        self.ready(); self.changed.clear()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.router.request_packet, 'thread/fork', {})
            self.assertTrue(self.changed.wait(1)); self.router.close()
            with self.assertRaises(AppServerUnknownResult): pending.result(1)
        self.assertEqual(len(self.writes), 3)

    def test_id_expansion_rejects_only_large_app_request_and_drops_pending(self):
        self.ready()
        too_large = {'id': 7, 'method': 'thread/read', 'params': {'threadId': 'x' * 160}}
        valid = {'id': 8, 'method': 'thread/read', 'params': {'threadId': 'short'}}
        data = b''.join(json.dumps(value).encode()+b'\n' for value in (too_large, valid))
        with patch('bridge.clients.codex.desktop_stdio.MAX_LINE', 230):
            _forward_input(io.BytesIO(data), SimpleNamespace(send=self.router.from_app), self.app.append, threading.Event())
        self.assertTrue(self.router.ready)
        self.assertEqual(self.app[-1]['id'], 7)
        self.assertIn('error', self.app[-1])
        self.assertEqual(len(self.router.pending), 1)
        self.router.from_native({'id': self.writes[-1]['id'], 'result': {'ok': True}})
        self.assertEqual(self.app[-1], {'id': 8, 'result': {'ok': True}})


class MetadataClientTests(unittest.TestCase):
    def test_explicit_native_rejection_is_distinct_from_a_missing_reply(self):
        client = MetadataClient('.', {'generation': 'fixture'})
        client.service = Mock()
        with patch('bridge.clients.codex.desktop_runtime_windows._verify'):
            client.service._exchange.return_value = {'id': 'native-id', 'error': {'code': -32601, 'message': 'unsupported'}}
            with self.assertRaises(DeleteRejected): client.request('thread/delete', {'threadId': 'fixture'})
            client.service._exchange.side_effect = LocalRequestNotSent('peer changed')
            with self.assertRaises(AppServerRequestNotSent): client.request('thread/fork', {})
            client.service._exchange.side_effect = EOFError('reply missing')
            with self.assertRaises(AppServerUnknownResult): client.request('thread/fork', {})
