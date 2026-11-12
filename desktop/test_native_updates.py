import unittest
from native_updates import newest_release,version_key,check_updates
from unittest.mock import Mock


class NativeUpdateChecks(unittest.TestCase):
    def test_prerelease_numeric_order_and_invalid_versions(self):
        self.assertGreater(version_key('0.1.0-beta.10'),version_key('0.1.0-beta.3'))
        self.assertGreater(version_key('0.1.0'),version_key('0.1.0-beta.10'))
        self.assertIsNone(version_key('0.1.0-beta.03')); self.assertIsNone(version_key('01.1.0'))

    def test_release_filter_excludes_draft_foreign_site_and_beta_for_stable(self):
        row={'tag_name':'desktop-v0.2.0-beta.1','html_url':'https://github.com/lby749/Vidence/releases/tag/desktop-v0.2.0-beta.1','published_at':'2026','prerelease':True,'assets':[{'name':'Vidence-Desktop-Windows-x64.zip'}]}
        self.assertEqual(newest_release([row],'0.1.0-beta.3')['version'],'0.2.0-beta.1')
        self.assertIsNone(newest_release([row],'0.1.0'))
        self.assertIsNone(newest_release([dict(row,draft=True)],'0.1.0-beta.3'))
        self.assertIsNone(newest_release([dict(row,html_url='https://example.org/download')],'0.1.0-beta.3'))

    def test_desktop_channel_ignores_plugin_and_missing_packages(self):
        row={'tag_name':'desktop-v0.4.3','html_url':'https://github.com/lby749/Vidence/releases/tag/desktop-v0.4.3','published_at':'2026','assets':[{'name':'Vidence-Desktop-Windows-x64.zip'}]}
        plugin=dict(row,tag_name='v9.0.0',html_url='https://github.com/lby749/Vidence/releases/tag/v9.0.0')
        self.assertIsNone(newest_release([plugin,dict(row,assets=None),dict(row,assets=[])],'0.4.2'))
        self.assertEqual(newest_release([plugin,row],'0.4.2')['version'],'0.4.3')

    def test_channel_migration_keeps_auto_off_and_discards_old_update(self):
        store=Mock(); store.setting.return_value={'auto':False,'checkedAt':99,'update':{'version':'9.0.0'}}
        self.assertEqual(check_updates(store,'0.4.2'),{'auto':False,'checkedAt':0,'channel':'desktop'})
        store.set_setting.assert_called_once_with('appUpdates',{'auto':False,'checkedAt':0,'channel':'desktop'})


if __name__=='__main__':unittest.main()
