from __future__ import annotations

import argparse
import socket
import ssl
import subprocess
import sys
import time
from datetime import datetime, timezone
from shutil import which
from typing import Protocol, runtime_checkable
from urllib.parse import urlparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Probe a URL every 30 seconds and track outbound TCP segment counts without sudo."
    )
    parser.add_argument(
        "url",
        nargs="?",
        default="https://www.google.com",
        help="URL to probe, for example https://www.google.com",
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=30.0,
        help="Seconds between checks. Default: 30",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Timeout for the TCP probe in seconds. Default: 5",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="Send a desktop notification after each probe using notify-send.",
    )
    parser.add_argument(
        "--restart-wifi",
        action="store_true",
        help="Restart Wi-Fi with gdbus when the probe changes from up to down.",
    )
    parser.add_argument(
        "--restart-wifi-strategy",
        choices=("auto", "dbus", "nmcli"),
        default="auto",
        help="Wi-Fi restart strategy to use when --restart-wifi is enabled. Default: auto",
    )
    return parser


def now_stamp() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def resolve_target(url: str) -> tuple[str, int, str]:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f"Invalid URL: {url}")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    return parsed.hostname, port, path


def tcp_probe(host: str, port: int, path: str, scheme: str, timeout: float) -> tuple[bool, str]:
    try:
        address_info = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        return False, str(exc)

    last_error: Exception | None = None

    for family, socket_type, protocol, _, sockaddr in address_info:
        try:
            with socket.socket(family, socket_type, protocol) as sock:
                sock.settimeout(timeout)
                sock.connect(sockaddr)

                request = f"HEAD {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"

                if scheme == "https":
                    context = ssl.create_default_context()
                    with context.wrap_socket(sock, server_hostname=host) as tls_sock:
                        tls_sock.sendall(request.encode("utf-8"))
                        tls_sock.recv(1024)
                else:
                    sock.sendall(request.encode("utf-8"))
                    sock.recv(1024)

                return True, f"connected to {sockaddr[0]}:{sockaddr[1]}"
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    if last_error is None:
        return False, "no address information available"
    return False, str(last_error)


def read_tcp_counters() -> dict[str, int]:
    with open("/proc/net/snmp", encoding="utf-8") as handle:
        lines = [line.strip() for line in handle if line.startswith("Tcp:")]

    if len(lines) < 2:
        raise RuntimeError("could not read TCP counters from /proc/net/snmp")

    headers = lines[-2].split()[1:]
    values = lines[-1].split()[1:]
    return {header: int(value) for header, value in zip(headers, values, strict=True)}


def format_tcp_delta(before: dict[str, int], after: dict[str, int]) -> str:
    fields = ["OutSegs", "InSegs", "RetransSegs", "OutRsts"]
    parts = [
        f"{field}={after[field] - before[field]}" for field in fields if field in before and field in after
    ]
    return ", ".join(parts)


def format_minutes_since(started_at: float) -> str:
    minutes = (time.monotonic() - started_at) / 60.0
    return f"{minutes:.1f}m"


def send_notification(title: str, body: str, *, success: bool) -> None:
    notify_send = which("notify-send")
    if not notify_send:
        return

    icon_name = "network-wireless-symbolic" if success else "network-error-symbolic"
    subprocess.run(
        [notify_send, "--icon", icon_name, title, body],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@runtime_checkable
class RestartWifiStrategy(Protocol):
    def available(self) -> bool: ...

    def restart(self) -> None: ...


class RestartWifiDbus:
    def available(self) -> bool:
        return which("gdbus") is not None

    def restart(self) -> None:
        command_base = [
            "gdbus",
            "call",
            "--system",
            "--dest",
            "org.freedesktop.NetworkManager",
            "--object-path",
            "/org/freedesktop/NetworkManager",
            "--method",
            "org.freedesktop.NetworkManager.Enable",
        ]

        subprocess.run(
            command_base + ["false"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        time.sleep(1.0)
        subprocess.run(
            command_base + ["true"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )


class RestartWifiNmcli:
    def available(self) -> bool:
        return which("nmcli") is not None

    def restart(self) -> None:
        subprocess.run(
            ["nmcli", "radio", "wifi", "off"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.0)
        subprocess.run(
            ["nmcli", "radio", "wifi", "on"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def select_restart_wifi_strategy(strategy_name: str) -> RestartWifiStrategy | None:
    strategies: dict[str, RestartWifiStrategy] = {
        "dbus": RestartWifiDbus(),
        "nmcli": RestartWifiNmcli(),
    }

    if strategy_name == "auto":
        for candidate in (strategies["dbus"], strategies["nmcli"]):
            if candidate.available():
                return candidate
        return None

    strategy = strategies[strategy_name]
    return strategy if strategy.available() else None


def monitor(
    url: str,
    interval: float,
    timeout: float,
    notify: bool,
    restart_wifi_on_drop: bool,
    restart_wifi_strategy: RestartWifiStrategy | None,
) -> None:
    host, port, path = resolve_target(url)
    scheme = urlparse(url).scheme.lower()
    previous_status: bool | None = None
    status_changed_at = time.monotonic()

    print(f"[{now_stamp()}] monitoring {url} every {interval:.1f}s")

    try:
        while True:
            started = time.monotonic()
            tcp_before = read_tcp_counters()
            probe_ok, probe_message = tcp_probe(host, port, path, scheme, timeout)
            tcp_after = read_tcp_counters()

            if previous_status is None:
                status_note = "since start"
            elif probe_ok != previous_status:
                status_changed_at = started
                status_note = "since status change"
            else:
                status_note = f"since {format_minutes_since(status_changed_at)}"

            print(f"[{now_stamp()}] probe={'ok' if probe_ok else 'fail'} {probe_message}")
            tcp_delta = format_tcp_delta(tcp_before, tcp_after)
            print(f"[{now_stamp()}] tcp delta: {tcp_delta} ({status_note})")

            if notify and previous_status is not None and probe_ok != previous_status:
                status = "OK" if probe_ok else "FAILED"
                body = f"{url}\nTCP: {tcp_delta or 'no delta reported'}\n{probe_message}"
                send_notification(f"Network probe {status}", body, success=probe_ok)

            if restart_wifi_on_drop and previous_status is True and not probe_ok:
                if restart_wifi_strategy is None:
                    print(f"[{now_stamp()}] restart wifi requested but no strategy is available")
                else:
                    strategy_name = restart_wifi_strategy.__class__.__name__
                    print(f"[{now_stamp()}] restarting wifi via {strategy_name}")
                    restart_wifi_strategy.restart()

            previous_status = probe_ok

            elapsed = time.monotonic() - started
            remaining = interval - elapsed
            while remaining > 0:
                time.sleep(min(remaining, 0.5))
                remaining = interval - (time.monotonic() - started)
    except KeyboardInterrupt:
        print(f"[{now_stamp()}] stopping")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        restart_wifi_strategy = select_restart_wifi_strategy(args.restart_wifi_strategy)
        monitor(
            args.url,
            args.interval,
            args.timeout,
            args.notify,
            args.restart_wifi,
            restart_wifi_strategy,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
