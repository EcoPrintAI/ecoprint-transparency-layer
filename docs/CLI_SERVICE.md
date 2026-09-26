# Local SigSense service

Build the telemetry engine before installing it:

```sh
cd sigsense/engine && make
```

Run service management from an elevated terminal:

```sh
node bin/ecoprint.js service install
node bin/ecoprint.js service status
node bin/ecoprint.js service stop
node bin/ecoprint.js service start
node bin/ecoprint.js service uninstall
```

The installer uses a launchd LaunchDaemon on macOS, a systemd service on Linux,
and the Windows Service Control Manager on Windows. Uninstall preserves the
telemetry database and configuration. Unix installs add the invoking user to
the `ecoprint` group; sign out and back in before using the service IPC socket.
Windows grants standard users read access to telemetry data and lets the
LocalService account write it.

The CLI marks each command with `BEGIN <run-id>` and `END <run-id>`. The service
accepts only `PING`, `STATUS`, and those run markers. Unix sockets use mode
`0660` and the `ecoprint` group. Windows uses a named pipe with an ACL for
standard users, administrators, and SYSTEM. The service itself is controlled
by launchd, systemd, or SCM; IPC has no shutdown command.

Installed telemetry databases are stored under `/Library/Application
Support/EcoPrint/Data` on macOS, `/var/lib/ecoprint` on Linux, and
`%ProgramData%\EcoPrint\Data` on Windows. The CLI selects an installed database
when it exists; `ECOPRINT_TELEMETRY_DB` overrides the path. The telemetry config
is service-owned and contains only the existing SigSense provider settings.

Windows currently records an explicitly labeled PDH-derived estimate. The
service wrapper does not turn that estimate into a hardware power reading.
