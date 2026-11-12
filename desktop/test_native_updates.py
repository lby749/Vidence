import unittest
from native_updates import newest_release,version_key


class NativeUpdateChecks(unittest.TestCase):
    def test_prerelease_numeric_order_and_invalid_versions(self):
        self.assertGreater(version_key('0.1.0-beta.10'),version_key('0.1.0-beta.3'))
        self.assertGreater(version_key('0.1.0'),version_key('0.1.0-beta.10'))
        self.assertIsNone(version_key('0.1.0-beta.03')); self.assertIsNone(version_key('01.1.0'))

    def test_release_filter_excludes_draft_foreign_site_and_beta_for_stable(self):
        row={'tag_name':'v0.2.0-beta.1','html_url':'https://github.com/lby749/Vidence/releases/tag/v0.2.0-beta.1','published_at':'2026','prerelease':True}
        self.assertEqual(newest_release([row],'0.1.0-beta.3')['version'],'0.2.0-beta.1')
        self.assertIsNone(newest_release([row],'0.1.0'))
        self.assertIsNone(newest_release([dict(row,draft=True)],'0.1.0-beta.3'))
        self.assertIsNone(newest_release([dict(row,html_url='https://example.org/download')],'0.1.0-beta.3'))


if __name__=='__main__':unittest.main()
