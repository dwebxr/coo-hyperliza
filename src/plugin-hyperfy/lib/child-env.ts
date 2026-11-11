/**
 * The environment the agent's helper processes (headless Chromium, ffmpeg) are started with.
 *
 * A child process inherits the whole environment unless told otherwise, and the agent's holds API
 * keys, the elizaOS API token, the database URL and, until the service has read it, the tip
 * wallet's private key. None of that is of any use to a browser or to ffmpeg, so they get only
 * what a program needs to start and find its files, by name. Proxy settings are left out on
 * purpose (neither helper may use the network). Checked on macOS; the Linux names (display,
 * fontconfig, library path) are listed from what Chromium documents, not from a run.
 */
const PASSED_ON: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  // Linux: display server, per-user directories, fonts, shared libraries
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'LD_LIBRARY_PATH',
  // macOS
  '__CF_USER_TEXT_ENCODING',
];

/** `source` reduced to the variables in PASSED_ON that are set. */
export function childEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ON) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
