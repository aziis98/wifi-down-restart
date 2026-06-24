import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WifiDownRestartPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create a Preferences Page
        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'network-wireless-symbolic',
        });

        // Group 1: Probe Configuration
        const probeGroup = new Adw.PreferencesGroup({
            title: _('Probe Configuration'),
            description: _('Configure the network probe target and timers'),
        });
        page.add(probeGroup);

        // URL Row
        const urlRow = new Adw.EntryRow({
            title: _('Target URL'),
        });
        settings.bind('url', urlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        probeGroup.add(urlRow);

        // Interval Row
        const intervalAdjustment = new Gtk.Adjustment({
            lower: 5.0,
            upper: 3600.0,
            step_increment: 1.0,
            page_increment: 10.0,
        });
        const intervalRow = new Adw.SpinRow({
            title: _('Probe Interval (seconds)'),
            subtitle: _('Time to wait between probes'),
            adjustment: intervalAdjustment,
            value: settings.get_double('interval'),
            digits: 1,
        });
        settings.bind('interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        probeGroup.add(intervalRow);

        // Timeout Row
        const timeoutAdjustment = new Gtk.Adjustment({
            lower: 1.0,
            upper: 60.0,
            step_increment: 0.5,
            page_increment: 5.0,
        });
        const timeoutRow = new Adw.SpinRow({
            title: _('Timeout (seconds)'),
            subtitle: _('DNS lookup and TCP connection timeout'),
            adjustment: timeoutAdjustment,
            value: settings.get_double('timeout'),
            digits: 1,
        });
        settings.bind('timeout', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        probeGroup.add(timeoutRow);

        // Group 2: Wi-Fi SSID Filtering
        const ssidGroup = new Adw.PreferencesGroup({
            title: _('Wi-Fi Filtering'),
            description: _('Restrict monitoring to specific wireless networks'),
        });
        page.add(ssidGroup);

        // Wi-Fi Filter Row
        const wifiFilterRow = new Adw.EntryRow({
            title: _('Tracked Wi-Fi SSIDs (comma-separated)'),
        });
        settings.bind('wifi-filter', wifiFilterRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        ssidGroup.add(wifiFilterRow);

        // Group 3: Actions & Notifications
        const recoveryGroup = new Adw.PreferencesGroup({
            title: _('Actions & Notifications'),
            description: _('What to do when connection fails'),
        });
        page.add(recoveryGroup);

        // Notifications switch
        const notifyRow = new Adw.SwitchRow({
            title: _('Show Notifications'),
            subtitle: _('Notify on connection state change (OK / FAILED)'),
        });
        settings.bind('notify', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        recoveryGroup.add(notifyRow);

        // Restart Wifi switch
        const restartWifiRow = new Adw.SwitchRow({
            title: _('Restart Wi-Fi on drop'),
            subtitle: _('Toggle Wi-Fi radio on/off automatically when connection is lost'),
        });
        settings.bind('restart-wifi', restartWifiRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        recoveryGroup.add(restartWifiRow);

        // Restart Wifi Strategy dropdown
        const strategyModel = Gtk.StringList.new(['auto', 'dbus', 'nmcli']);
        const strategyRow = new Adw.ComboRow({
            title: _('Wi-Fi Restart Strategy'),
            subtitle: _('The mechanism used to cycle the Wi-Fi radio'),
            model: strategyModel,
        });
        const strategies = ['auto', 'dbus', 'nmcli'];
        const currentStrategy = settings.get_string('restart-wifi-strategy');
        const selectedIdx = strategies.indexOf(currentStrategy);
        if (selectedIdx !== -1) {
            strategyRow.selected = selectedIdx;
        }
        strategyRow.connect('notify::selected', () => {
            settings.set_string('restart-wifi-strategy', strategies[strategyRow.selected]);
        });
        recoveryGroup.add(strategyRow);

        window.add(page);
    }
}
