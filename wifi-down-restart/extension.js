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

        // Set up the menu header
        this.menu.setHeader('view-refresh-symbolic', 'WiFi Down Restart', 'Monitoring inactive');

        // Status menu item (read-only)
        this._statusItem = new PopupMenu.PopupMenuItem('Status: 🔴 Stopped', { reactive: false });
        this.menu.addMenuItem(this._statusItem);

        // TCP Delta menu item (read-only)
        this._tcpItem = new PopupMenu.PopupMenuItem('TCP Delta: N/A', { reactive: false });
        this.menu.addMenuItem(this._tcpItem);

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
            if (this._isToggledOn) {
                this._startMonitoring();
            } else {
                this._stopMonitoring();
            }
        });
    }

    _onSettingsChanged(key) {
        if (this._isToggledOn) {
            this._startMonitoring();
        }
    }

    _startMonitoring() {
        this._stopMonitoringProcessOnly();

        this._cancellable = new Gio.Cancellable();

        const url = this._settings.get_string('url') || 'https://www.google.com';
        const interval = this._settings.get_double('interval') || 30.0;
        const timeout = this._settings.get_double('timeout') || 5.0;
        const notify = this._settings.get_boolean('notify');
        const restartWifi = this._settings.get_boolean('restart-wifi');
        const restartWifiStrategy = this._settings.get_string('restart-wifi-strategy') || 'auto';
        const wifiFilter = this._settings.get_string('wifi-filter') || '';

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

        try {
            this._proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            this._proc.init(null);

            this.subtitle = 'Active';
            this.menu.setHeader('view-refresh-symbolic', 'WiFi Down Restart', `Monitoring: ${url}`);
            this._statusItem.label.set_text('Status: 🟡 Connecting...');
            this._tcpItem.label.set_text('TCP Delta: N/A');

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

    _parseLine(line) {
        line = String(line).trim();
        console.log(`[wifi-down-restart] _parseLine: parsing "${line}"`);

        // Handle SSID filtering messages from main.py
        if (line.includes('not in filter list. Skipping probe.')) {
            const ssidMatch = line.match(/SSID '(.*?)'/);
            const ssid = ssidMatch ? ssidMatch[1] : 'Unknown';
            this.subtitle = `Inactive (${ssid})`;
            this._statusItem.label.set_text(`Status: 🔴 Inactive (${ssid})`);
            this._tcpItem.label.set_text('TCP Delta: N/A');
            return;
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

        // Parse tcp delta line: e.g., tcp delta: OutSegs=0, InSegs=0 (since 2.1m)
        if (line.includes('tcp delta:')) {
            console.log('[wifi-down-restart] _parseLine: matched "tcp delta:"');
            const deltaMatch = line.match(/tcp delta:\s+(.*?)\s*\((.*?)\)/);
            try {
                if (deltaMatch) {
                    const delta = deltaMatch[1];
                    const duration = deltaMatch[2];
                    this._tcpItem.label.set_text(`TCP: ${delta} (${duration})`);
                } else {
                    const deltaSimple = line.match(/tcp delta:\s+(.*)/);
                    if (deltaSimple) {
                        this._tcpItem.label.set_text(`TCP: ${deltaSimple[1]}`);
                    }
                }
                console.log('[wifi-down-restart] _parseLine: successfully updated TCP label');
            } catch (err) {
                console.error(`[wifi-down-restart] _parseLine TCP error: ${err.message}`);
            }
        }
    }

    _stopMonitoringProcessOnly() {
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
        this._tcpItem.label.set_text('TCP Delta: N/A');
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
