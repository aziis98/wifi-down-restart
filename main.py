from __future__ import annotations

import argparse
import socket
import ssl
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
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
        help="Timeout for DNS lookup and TCP probe in seconds. Default: 5",
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
    parser.add_argument(
        "--wifi-filter",
        help="Comma-separated list of WiFi SSIDs to restrict monitoring to. If set, probe runs only when on these SSIDs.",
    )
    parser.add_argument(
        "--recheck",
        action="store_true",
        help="Perform a secondary probe check after a delay before restarting Wi-Fi to confirm it is still down",
    )
    parser.add_argument(
        "--recheck-delay",
        type=float,
        default=1.5,
        help="Delay in seconds before performing the secondary check. Default: 1.5",
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


def is_ip_address(host: str) -> bool:
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except OSError:
            pass
    return False


def tcp_probe(host: str, port: int, path: str, scheme: str, timeout: float) -> tuple[bool, str, float | None]:
    import dns.resolver
    import dns.exception

    if is_ip_address(host):
        try:
            address_info = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        except socket.gaierror as exc:
            return False, str(exc), None
    else:
        try:
            resolver = dns.resolver.Resolver()
        except dns.resolver.NoResolverConfiguration:
            resolver = dns.resolver.Resolver(configure=False)
            resolver.nameservers = ["8.8.8.8", "1.1.1.1", "8.8.4.4", "1.0.0.1"]

        resolver.timeout = timeout
        resolver.lifetime = timeout

        address_info = []
        dns_errors = []
        start_time = time.monotonic()

        # Try resolving A records (IPv4)
        try:
            answers = resolver.resolve(host, "A")
            for rdata in answers:
                address_info.append((socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (rdata.address, port)))
        except (dns.resolver.LifetimeTimeout, dns.resolver.Timeout) as exc:
            dns_errors.append(exc)
        except Exception as exc:
            dns_errors.append(exc)

        # Update remaining timeout for AAAA records (IPv6)
        elapsed = time.monotonic() - start_time
        remaining = timeout - elapsed
        if remaining > 0:
            resolver.timeout = remaining
            resolver.lifetime = remaining
            try:
                answers = resolver.resolve(host, "AAAA")
                for rdata in answers:
                    address_info.append((socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (rdata.address, port, 0, 0)))
            except (dns.resolver.LifetimeTimeout, dns.resolver.Timeout) as exc:
                dns_errors.append(exc)
            except Exception as exc:
                dns_errors.append(exc)

        if not address_info:
            if any(isinstance(err, (dns.resolver.LifetimeTimeout, dns.resolver.Timeout)) for err in dns_errors):
                return False, f"DNS lookup timed out after {timeout:.1f}s", None
            if dns_errors:
                return False, f"DNS resolution failed: {dns_errors[-1]}", None
            return False, "no address information available", None

    last_error: Exception | None = None

    for family, socket_type, protocol, _, sockaddr in address_info:
        try:
            with socket.socket(family, socket_type, protocol) as sock:
                sock.settimeout(timeout)
                sock.connect(sockaddr)

                request = f"HEAD {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"

                # measure latency: time from sending request to receiving first response bytes
                try:
                    if scheme == "https":
                        context = ssl.create_default_context()
                        with context.wrap_socket(sock, server_hostname=host) as tls_sock:
                            start = time.monotonic()
                            tls_sock.sendall(request.encode("utf-8"))
                            tls_sock.recv(1024)
                            latency_ms = (time.monotonic() - start) * 1000.0
                    else:
                        start = time.monotonic()
                        sock.sendall(request.encode("utf-8"))
                        sock.recv(1024)
                        latency_ms = (time.monotonic() - start) * 1000.0
                except Exception:
                    # if sending/receiving fails, propagate to outer except handler
                    raise

                return True, f"connected to {sockaddr[0]}:{sockaddr[1]}", latency_ms
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    if last_error is None:
        return False, "no address information available", None
    return False, str(last_error), None


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

        try:
            subprocess.run(
                command_base + ["false"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        finally:
            time.sleep(1.0)
            subprocess.run(
                command_base + ["true"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )


class RestartWifiNmcli:
    def available(self) -> bool:
        return which("nmcli") is not None

    def restart(self) -> None:
        try:
            subprocess.run(
                ["nmcli", "radio", "wifi", "off"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        finally:
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


def get_current_wifi_ssid() -> str | None:
    nmcli = which("nmcli")
    if nmcli:
        try:
            result = subprocess.run(
                [nmcli, "-t", "-f", "active,ssid", "dev", "wifi"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if line.startswith("yes:"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass

    iwgetid = which("iwgetid")
    if iwgetid:
        try:
            result = subprocess.run(
                [iwgetid, "-r"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass

    return None


def monitor(
    url: str,
    interval: float,
    timeout: float,
    notify: bool,
    restart_wifi_on_drop: bool,
    restart_wifi_strategy: RestartWifiStrategy | None,
    wifi_filter: list[str] | None,
    recheck: bool,
    recheck_delay: float,
) -> None:
    host, port, path = resolve_target(url)
    scheme = urlparse(url).scheme.lower()
    previous_status: bool | None = None
    status_changed_at = time.monotonic()

    wifi_filter_str = ", ".join(wifi_filter) if wifi_filter else "any"
    print(f"[{now_stamp()}] monitoring {url} every {interval:.1f}s (wifi filter: {wifi_filter_str})")

    try:
        while True:
            started = time.monotonic()

            if wifi_filter:
                current_ssid = get_current_wifi_ssid()
                if not current_ssid or current_ssid not in wifi_filter:
                    ssid_display = current_ssid if current_ssid else "<none>"
                    print(
                        f"[{now_stamp()}] SSID '{ssid_display}' not in filter list. Skipping probe."
                    )
                    previous_status = None  # Reset state on ssid mismatch/disconnect
                    elapsed = time.monotonic() - started
                    remaining = interval - elapsed
                    while remaining > 0:
                        time.sleep(min(remaining, 0.5))
                        remaining = interval - (time.monotonic() - started)
                    continue

            tcp_before = read_tcp_counters()
            probe_ok, probe_message, probe_latency = tcp_probe(host, port, path, scheme, timeout)
            tcp_after = read_tcp_counters()

            if previous_status is None:
                status_note = "since start"
            elif probe_ok != previous_status:
                status_changed_at = started
                status_note = "since status change"
            else:
                status_note = f"since {format_minutes_since(status_changed_at)}"

            latency_str = f"{probe_latency:.1f}ms" if probe_latency is not None else "n/a"
            print(
                f"[{now_stamp()}] probe={'ok' if probe_ok else 'fail'} {probe_message} latency={latency_str}"
            )
            tcp_delta = format_tcp_delta(tcp_before, tcp_after)
            print(f"[{now_stamp()}] tcp delta: {tcp_delta} ({status_note})")

            if notify and previous_status is not None and probe_ok != previous_status:
                status = "OK" if probe_ok else "FAILED"
                body = (
                    f"{url}\nLatency: {latency_str}\nTCP: {tcp_delta or 'no delta reported'}\n{probe_message}"
                )
                send_notification(f"Network probe {status}", body, success=probe_ok)

            if restart_wifi_on_drop and previous_status is True and not probe_ok:
                should_restart = True
                if recheck:
                    print(f"[{now_stamp()}] probe failed. Waiting {recheck_delay:.1f}s to recheck...")
                    time.sleep(recheck_delay)
                    recheck_ok, recheck_msg, _ = tcp_probe(host, port, path, scheme, timeout)
                    if recheck_ok:
                        print(f"[{now_stamp()}] recheck=ok ({recheck_msg}). Connection recovered, skipping restart.")
                        should_restart = False
                        probe_ok = True  # Treat as recovered
                    else:
                        print(f"[{now_stamp()}] recheck=fail ({recheck_msg}). Connection still down.")

                if should_restart:
                    current_ssid = get_current_wifi_ssid()
                    if not current_ssid:
                        print(f"[{now_stamp()}] wifi is down (not connected to any SSID), skipping restart")
                    elif restart_wifi_strategy is None:
                        print(f"[{now_stamp()}] restart wifi requested but no strategy is available")
                    else:
                        strategy_name = restart_wifi_strategy.__class__.__name__
                        print(f"[{now_stamp()}] restarting wifi via {strategy_name} (current SSID: {current_ssid})")
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

    wifi_filter = None
    if args.wifi_filter:
        wifi_filter = [ssid.strip() for ssid in args.wifi_filter.split(",") if ssid.strip()]

    try:
        restart_wifi_strategy = select_restart_wifi_strategy(args.restart_wifi_strategy)
        monitor(
            args.url,
            args.interval,
            args.timeout,
            args.notify,
            args.restart_wifi,
            restart_wifi_strategy,
            wifi_filter,
            args.recheck,
            args.recheck_delay,
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
