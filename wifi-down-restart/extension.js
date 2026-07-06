import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Promisify read_line_async
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

const WifiDownRestartToggle = GObject.registerClass(
class WifiDownRestartToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: 'WiFi Down Restart',
            iconName: 'view-refresh-symbolic',
            toggleMode: true,
        });

        this._extension = extension;
        this._settings = extension.getSettings();
        this._proc = null;
        this._cancellable = null;
        this._isToggledOn = false;

        this._restartCount = 0;
        this._lastRestartTime = null;
        this._restartTimes = [];
        this._statsTimeoutId = null;

        // Set up the menu header
        this.menu.setHeader('view-refresh-symbolic', 'WiFi Down Restart', 'Monitoring inactive');

        // Status menu item (read-only)
        this._statusItem = new PopupMenu.PopupMenuItem('Status: 🔴 Stopped', { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        // Stats menu item (read-only)
        this._statsItem = new PopupMenu.PopupMenuItem('Restarts: N/A', { reactive: false });
        this.menu.addMenuItem(this._statsItem);

        // Separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Open Preferences menu item
        this._prefsItem = new PopupMenu.PopupMenuItem('Open Settings...');
        this._prefsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(this._prefsItem);

        // Track GSettings changes
        this._settingsSignalId = this._settings.connect('changed', (settings, key) => {
            this._onSettingsChanged(key);
        });

        // Initialize state
        this.subtitle = 'Stopped';
        
        // Handle toggle state change
        this.connect('notify::checked', () => {
            this._isToggledOn = this.checked;
            this._settings.set_boolean('service-enabled', this.checked);
            this._settings.apply();
            if (this._isToggledOn) {
                this._startMonitoring();
            } else {
                this._stopMonitoring();
            }
        });

        // Restore toggle state from persisted settings
        if (this._settings.get_boolean('service-enabled')) {
            this.checked = true;
        }
    }

    _onSettingsChanged(key) {
        if (this._isToggledOn) {
            this._startMonitoring();
        }
    }

    _readDailyRestartCount() {
        const logDir = GLib.get_home_dir() + '/.local/share/track-unipisa-down';
        const logFile = logDir + '/restarts.log';
        const logFileGio = Gio.File.new_for_path(logFile);
        if (!logFileGio.query_exists(null)) {
            return 0;
        }

        const today = new GLib.DateTime.now_local().format('%Y-%m-%d');
        let count = 0;

        try {
            const contents = logFileGio.load_contents(null);
            const text = String(contents[0]);
            for (const line of text.split('\n')) {
                if (line.startsWith(today)) {
                    count++;
                }
            }
        } catch (e) {
            console.error(`[WiFi Down Restart] Error reading log file: ${e.message}`);
            return 0;
        }

        return count;
    }

    _startMonitoring() {
        this._stopMonitoringProcessOnly();

        this._restartCount = this._readDailyRestartCount();
        this._lastRestartTime = null;
        this._restartTimes = [];

        this._cancellable = new Gio.Cancellable();

        const url = this._settings.get_string('url') || 'https://www.google.com';
        const interval = this._settings.get_double('interval') || 30.0;
        const timeout = this._settings.get_double('timeout') || 5.0;
        const notify = this._settings.get_boolean('notify');
        const restartWifi = this._settings.get_boolean('restart-wifi');
        const restartWifiStrategy = this._settings.get_string('restart-wifi-strategy') || 'auto';
        const wifiFilter = this._settings.get_string('wifi-filter') || '';
        const recheckEnabled = this._settings.get_boolean('recheck-enabled');
        const recheckDelay = this._settings.get_double('recheck-delay');

        // Resolve extension directory in case it's a symbolic link (common for local dev installations)
        let extDir = this._extension.dir;
        try {
            let info = extDir.query_info(
                'standard::is-symlink,standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (info.get_is_symlink()) {
                let target = info.get_symlink_target();
                extDir = extDir.get_parent().resolve_relative_path(target);
            }
        } catch (e) {
            console.error(`[WiFi Down Restart] Error checking symlink: ${e.message}`);
        }

        const pythonFile = extDir.get_parent().get_child('.venv').get_child('bin').get_child('python');
        const scriptFile = extDir.get_parent().get_child('main.py');

        let pythonPath = 'python3';
        if (pythonFile.query_exists(null)) {
            pythonPath = pythonFile.get_path();
        }

        let scriptPath = 'main.py';
        if (scriptFile.query_exists(null)) {
            scriptPath = scriptFile.get_path();
        }

        let argv = [pythonPath, '-u', scriptPath, url];
        argv.push('--interval', String(interval));
        argv.push('--timeout', String(timeout));
        if (notify) {
            argv.push('--notify');
        }
        if (restartWifi) {
            argv.push('--restart-wifi');
            argv.push('--restart-wifi-strategy', restartWifiStrategy);
        }
        if (wifiFilter) {
            argv.push('--wifi-filter', wifiFilter);
        }
        if (recheckEnabled) {
            argv.push('--recheck');
            argv.push('--recheck-delay', String(recheckDelay));
        }

        try {
            this._proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            this._proc.init(null);

            this.subtitle = 'Active';
            this.menu.setHeader('view-refresh-symbolic', 'WiFi Down Restart', `Monitoring: ${url}`);
            this._statusItem.label.set_text('Status: 🟡 Connecting...');
            this._statsItem.label.set_text('Restarts: 0 (last: N/A, avg: N/A)');

            this._startStatsTimer();
            this._readStdout();
        } catch (e) {
            console.error(`[WiFi Down Restart] Failed to start subprocess: ${e.message}`);
            this.subtitle = 'Error starting';
            this._statusItem.label.set_text('Status: 🔴 Error starting process');
        }
    }

    async _readStdout() {
        const stdoutStream = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
        });

        const proc = this._proc;

        while (this._proc && this._proc === proc) {
            try {
                let [line] = await stdoutStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable);
                if (line === null) {
                    // EOF
                    break;
                }

                console.log(`[wifi-down-restart] ${line}`);
                this._parseLine(line);
            } catch (e) {
                if (e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    break;
                }
                console.error(`[wifi-down-restart] Error reading stdout: ${e.message}`);
                break;
            }
        }
    }

    _formatTimeSince(dt) {
        if (!dt) return 'N/A';
        const now = GLib.DateTime.new_now_local();
        const diffSeconds = Math.round(now.difference(dt) / 1000000);
        if (diffSeconds < 60) {
            return `${diffSeconds}s ago`;
        }
        const diffMinutes = Math.floor(diffSeconds / 60);
        const remSeconds = diffSeconds % 60;
        return `${diffMinutes}m ${remSeconds}s ago`;
    }

    _formatAverageRestartTime() {
        if (this._restartTimes.length === 0) {
            return 'N/A';
        }
        const sum = this._restartTimes.reduce((a, b) => a + b, 0);
        const avgSeconds = Math.round(sum / this._restartTimes.length);
        if (avgSeconds < 60) {
            return `${avgSeconds}s`;
        }
        const avgMinutes = Math.floor(avgSeconds / 60);
        const remSeconds = avgSeconds % 60;
        return `${avgMinutes}m ${remSeconds}s`;
    }

    _updateStatsLabel() {
        const lastStr = this._formatTimeSince(this._lastRestartTime);
        const avgStr = this._formatAverageRestartTime();
        this._statsItem.label.set_text(`Restarts: ${this._restartCount} (last: ${lastStr}, avg: ${avgStr})`);
    }

    _startStatsTimer() {
        this._stopStatsTimer();
        this._statsTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._updateStatsLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopStatsTimer() {
        if (this._statsTimeoutId) {
            GLib.Source.remove(this._statsTimeoutId);
            this._statsTimeoutId = null;
        }
    }

    _parseLine(line) {
        line = String(line).trim();
        console.log(`[wifi-down-restart] _parseLine: parsing "${line}"`);

        // Handle SSID filtering messages from main.py
        if (line.includes('not in filter list. Skipping probe.')) {
            const ssidMatch = line.match(/SSID '(.*?)'/);
            const ssid = ssidMatch ? ssidMatch[1] : 'Unknown';
            this.subtitle = `Inactive (${ssid})`;
            this._statusItem.label.set_text(`Status: 🔴 Inactive (${ssid})`);
            this._statsItem.label.set_text('Restarts: N/A');
            return;
        }

        // Parse restart line: e.g., restarting wifi via ...
        if (line.includes('restarting wifi via')) {
            console.log('[wifi-down-restart] _parseLine: matched "restarting wifi via"');
            const now = GLib.DateTime.new_now_local();
            this._restartCount++;
            if (this._lastRestartTime) {
                const diffSeconds = now.difference(this._lastRestartTime) / 1000000;
                this._restartTimes.push(diffSeconds);
            }
            this._lastRestartTime = now;
            this._updateStatsLabel();
        }

        // Parse probe line: e.g., probe=ok connected to 8.8.8.8:443 latency=12.3ms
        // or probe=fail DNS lookup timed out after 5.0s latency=n/a
        if (line.includes('probe=')) {
            console.log('[wifi-down-restart] _parseLine: matched "probe="');
            const isOk = line.includes('probe=ok');
            let latency = '';
            const latencyMatch = line.match(/latency=([^\s]+)/);
            if (latencyMatch) {
                latency = latencyMatch[1];
            }

            let msg = '';
            const msgMatch = line.match(/probe=(?:ok|fail)\s+(.*?)(?:\s+latency=|$)/);
            if (msgMatch) {
                msg = msgMatch[1];
            }

            console.log(`[wifi-down-restart] _parseLine: isOk=${isOk}, latency="${latency}", msg="${msg}"`);

            try {
                if (isOk) {
                    this.subtitle = `🟢 OK (${latency})`;
                    this._statusItem.label.set_text(`Status: 🟢 OK (${latency})`);
                } else {
                    this.subtitle = `🔴 FAIL`;
                    this._statusItem.label.set_text(`Status: 🔴 FAILED (${msg})`);
                }
                console.log('[wifi-down-restart] _parseLine: successfully updated status labels');
            } catch (err) {
                console.error(`[wifi-down-restart] _parseLine error: ${err.message}`);
            }
        }
    }

    _stopMonitoringProcessOnly() {
        this._stopStatsTimer();
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._proc) {
            this._proc.force_exit();
            this._proc = null;
        }
    }

    _stopMonitoring() {
        this._stopMonitoringProcessOnly();
        this.subtitle = 'Stopped';
        this.menu.setHeader('view-refresh-symbolic', 'WiFi Down Restart', 'Monitoring inactive');
        this._statusItem.label.set_text('Status: 🔴 Stopped');
        this._statsItem.label.set_text('Restarts: N/A');
        this.checked = false;
        this._isToggledOn = false;
    }

    destroy() {
        this._stopMonitoringProcessOnly();

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
        }

        super.destroy();
    }
});

const WifiDownRestartIndicator = GObject.registerClass(
class WifiDownRestartIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();
        
        // Create the quick settings item and push it
        this._toggle = new WifiDownRestartToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle.destroy();
        super.destroy();
    }
});

export default class WifiDownRestartExtension extends Extension {
    enable() {
        this._indicator = new WifiDownRestartIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
