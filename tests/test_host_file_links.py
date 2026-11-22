from pathlib import Path
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace
import threading

from bridge.features.workspace.files import host_file_links, workspace_references


class HostFileLinksTests(TestCase):
    def links(self, text, cwd='/project', files=()):
        return host_file_links({'cwd': cwd, 'turns': [{'items': [{'type': 'agentMessage', 'text': text}]}]}, files)

    def test_absolute_and_relative_links_do_not_read_the_rendering_host(self):
        with patch.object(Path, 'resolve', side_effect=AssertionError('No local resolution')), patch.object(Path, 'stat', side_effect=AssertionError('No local stat')):
            rows = self.links('[report](/outside/report.pdf) [same](file:///outside/report.pdf) [source](src/a.py:12)')
            self.assertEqual(len(rows), 2)
            report = next(row for row in rows if row['name'] == 'report.pdf')
            self.assertEqual(report['path'], '/outside/report.pdf')
            self.assertEqual(len(report['references']), 2)
            self.assertEqual(next(row['path'] for row in rows if row['name'] == 'a.py'), '/project/src/a.py')
            self.assertTrue(all(row['scope'] == 'host' and not row['image'] for row in rows))

    def test_windows_identity_is_interpreted_independently_of_gateway_os(self):
        rows = self.links('[a](<file:///F:/Outside/a.txt>) [b](<f:\\outside\\a.txt>) [c](src/test.py)', 'F:\\Project')
        self.assertEqual(len(rows), 2)
        self.assertEqual(sorted(len(row['references']) for row in rows), [1, 2])
        self.assertIn('F:/Project/src/test.py', [row['path'] for row in rows])

    def test_external_urls_network_paths_and_traversal_do_not_become_host_links(self):
        for reference in ['https://example.test/file', 'file://server/share/file', '//server/share/file', r'\\server\share\file', '../secret', '/dir/../secret', 'javascript:alert', 'data:text/plain,secret']:
            with self.subTest(reference=reference):
                self.assertEqual(self.links('[file](<' + reference + '>)'), [])

    def test_missing_project_keeps_absolute_user_attachments_but_not_relative_paths(self):
        rows = workspace_references([{'role': 'user', 'text': '[relative](file.txt)',
                                      'attachments': [{'type': 'file', 'path': '/records/voice.wav'}]}], '', host_files=True)
        self.assertEqual([row['path'] for row in rows], ['/records/voice.wav'])

    def test_outside_images_require_a_click_and_existing_trusted_artifacts_keep_their_identity(self):
        trusted = {'id': 'native', 'reference': '/project/image.png', 'references': ['/project/image.png'], 'image': True}
        rows = self.links('![inside](/project/image.png) ![outside](/outside/image.png)', files=[trusted])
        self.assertIs(rows[0], trusted)
        self.assertEqual(len(rows), 2)
        self.assertFalse(rows[1]['image'])
        self.assertEqual(rows[1]['path'], '/outside/image.png')

    def test_wsl_page_and_full_detail_keep_linux_paths_on_the_selected_entry(self):
        from bridge.features.endpoints.wsl import WslEntry
        from bridge.features.sessions.timeline import Timeline
        snapshot = {'sequence': 1, 'cwd': '/linux/project', 'turns': [{'id': 'turn', 'messages': [
            {'id': 'reply', 'kind': 'agentMessage', 'role': 'assistant', 'text': '[report](/linux/outside/report.txt)'}]}], 'requests': []}
        session = SimpleNamespace(condition=threading.RLock(), timeline=Timeline())
        entry = SimpleNamespace(session=lambda *a, **kw: session, view=lambda *a, **kw: snapshot)
        page = WslEntry.timeline_read(entry, 'native-session')
        self.assertEqual(page['files'][0]['path'], '/linux/outside/report.txt')
        detail = WslEntry.timeline_read(entry, 'native-session', 'detail', cursor=session.timeline.cursor(page['rows'][0]['key']))
        self.assertEqual(detail['files'], page['files'])

    def test_windows_verbatim_cwd_worktree_links_suffixes_and_plan_messages(self):
        cwd = r'\\?\D:\Projects\YHL\jh-sop'
        state = {'cwd': cwd, 'turns': [{'items': [
            {'type': 'agentMessage', 'text': '[rel](docs/README.md) [col](<D:/Projects/YHL/jh-sop-worktrees/b/A.java:42:5>) [rng](<file:///C:/Users/wangy/.codex/worktrees/9844/B.java#L10-L20>) [verb](<\\\\?\\D:\\Projects\\YHL\\jh-sop\\a.txt:15>)'},
            {'type': 'planImplementation', 'text': '[plan](<D:/Projects/YHL/jh-sop-worktrees/b/Plan.md:12-30>)'},
            {'type': 'agentMessage', 'text': '[unc](<\\\\?\\UNC\\server\\share\\file.txt>) [esc](../secret)'},
        ]}]}
        rows = host_file_links(state)
        paths = {row['path'] for row in rows}
        self.assertEqual(paths, {
            'D:/Projects/YHL/jh-sop/docs/README.md',
            'D:/Projects/YHL/jh-sop-worktrees/b/A.java',
            'C:/Users/wangy/.codex/worktrees/9844/B.java',
            'D:/Projects/YHL/jh-sop/a.txt',
            'D:/Projects/YHL/jh-sop-worktrees/b/Plan.md',
        })
