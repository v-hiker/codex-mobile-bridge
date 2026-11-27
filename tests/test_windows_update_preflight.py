import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.platforms.windows import updates


class WindowsUpdatePreflightTests(unittest.TestCase):
    def setUp(self):
        temporary = Path(__file__).resolve().parents[1]/'.tmp'
        temporary.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=temporary)
        self.addCleanup(self.directory.cleanup)
        self.worker = Path(self.directory.name)/'codex-mobile-gateway.exe'
        self.worker.touch()
        self.owner = {'pid': 7, 'image': os.path.normcase(str(self.worker)), 'created': 11}
        self.argv = [str(self.worker), 'zcode-pipe-host', '--data-dir', 'profile', '--application', 'ZCode.exe']

    def check(self, *, owner=None, argv=None, pids=(7,)):
        state = {self.worker: {'pids': pids, 'commands': {}}}
        with patch.object(updates, 'process_inventory', return_value=state), \
                patch.object(updates, 'identity', side_effect=owner or [self.owner, self.owner]), \
                patch.object(updates, 'process_args', return_value=argv or self.argv):
            updates.require_update_ready(self.worker)

    def test_live_same_installation_holder_blocks_without_stopping_it(self):
        with self.assertRaisesRegex(ValueError, '正常退出 ZCode'):
            self.check()

    def test_absent_exited_reused_pid_and_other_installation_do_not_block(self):
        self.check(pids=())
        self.check(owner=ProcessLookupError())
        self.check(owner=[{**self.owner, 'image': 'other-installation'}])
        with self.assertRaisesRegex(ValueError, '实例已变化'):
            self.check(owner=[self.owner, {**self.owner, 'created': 12}])

    def test_current_role_is_rechecked_and_query_failure_is_not_ignored(self):
        self.check(argv=[str(self.worker), 'snapshot-stream', '--data-dir', 'profile'])
        self.check(argv=['other-installation', *self.argv[1:]])
        with self.assertRaises(PermissionError):
            self.check(owner=PermissionError('Cannot verify process'))

    def test_codex_desktop_and_auxiliary_runtime_block_without_stopping_them(self):
        for arguments in [
                ['-c', 'check_for_update_on_startup=false', 'app-server', '--analytics-default-enabled'],
                ['exec-server', '--concurrent-requests', '8', '--remote', 'fixture'],
                ['codex-desktop-launch', '--configuration', 'fixture', '--', 'app-server'],
                ['codex-desktop-runtime', '--configuration', 'fixture', '--', 'app-server']]:
            with self.subTest(arguments=arguments), self.assertRaisesRegex(ValueError, '正常退出 Codex'):
                self.check(argv=[str(self.worker), *arguments])

    def test_stop_update_blockers_quits_codex_gracefully_and_skips_unrelated_ancestors(self):
        codex_exe = Path(self.directory.name) / 'ChatGPT.exe'
        codex_exe.touch()
        blocker = [{'provider': 'codex', 'pid': 7, 'argv': [str(self.worker), 'app-server']}]
        with patch.object(updates, 'inspect_update_blockers', side_effect=[blocker, []]), \
                patch.object(updates, '_identity', side_effect=[
                    {'pid': 7, 'image': os.path.normcase(str(self.worker)), 'parent': 8},
                    {'pid': 8, 'image': os.path.normcase(str(codex_exe)), 'parent': 1},
                ]), \
                patch.object(updates.codex_quit, 'stop_codex') as stop_codex, \
                patch.object(updates, '_force_terminate_image') as force_term:
            result = updates.stop_update_blockers(self.worker, force=True, timeout=1.0)
        self.assertEqual(result, {'stopped': ['codex'], 'ready': True})
        stop_codex.assert_called_once()
        self.assertEqual(Path(stop_codex.call_args.args[0].executable), codex_exe)
        force_term.assert_not_called()

        # Unrelated ancestor (e.g., explorer.exe) must never be targeted.
        explorer_exe = Path(self.directory.name) / 'explorer.exe'
        explorer_exe.touch()
        with patch.object(updates, '_identity', side_effect=[
            {'pid': 7, 'image': os.path.normcase(str(self.worker)), 'parent': 9},
            {'pid': 9, 'image': os.path.normcase(str(explorer_exe)), 'parent': 1},
        ]):
            self.assertEqual(updates._blocker_hosts(blocker, self.worker), [])

    def test_stop_update_blockers_respects_force_flag_when_graceful_quit_fails(self):
        codex_exe = Path(self.directory.name) / 'ChatGPT.exe'
        codex_exe.touch()
        blocker = [{'provider': 'codex', 'pid': 7, 'argv': [str(self.worker), 'app-server']}]
        identities = [
            {'pid': 7, 'image': os.path.normcase(str(self.worker)), 'parent': 8},
            {'pid': 8, 'image': os.path.normcase(str(codex_exe)), 'parent': 1},
        ]
        with patch.object(updates, 'inspect_update_blockers', return_value=blocker), \
                patch.object(updates, '_identity', side_effect=identities), \
                patch.object(updates.codex_quit, 'stop_codex', side_effect=ValueError('pending')), \
                patch.object(updates, '_force_terminate_image') as force_term:
            with self.assertRaisesRegex(ValueError, 'pending'):
                updates.stop_update_blockers(self.worker, force=False, timeout=0.1)
            force_term.assert_not_called()

        with patch.object(updates, 'inspect_update_blockers', side_effect=[blocker, []]), \
                patch.object(updates, '_identity', side_effect=identities), \
                patch.object(updates.codex_quit, 'stop_codex', side_effect=ValueError('pending')), \
                patch.object(updates, '_force_terminate_image') as force_term:
            result = updates.stop_update_blockers(self.worker, force=True, timeout=1.0)
        self.assertEqual(result, {'stopped': ['codex'], 'ready': True})
        force_term.assert_called_once_with(codex_exe)
