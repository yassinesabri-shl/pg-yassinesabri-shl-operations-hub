// Part of the harness asset library c6f3b4427d58f7c3 (see VERSION.json) · 2026-10-15
/**
 * docker-image.mjs — the Docker steps that a scanner needs: check that an image is on this
 * machine, fetch it where the caller says to, and run it in a container that reaches no network.
 * This module knows no scanner. `test-quality-scan.mjs` and `check-survey-secrets.mjs` use it, and
 * each passes its own image, label, mounts and command.
 *
 * Every failure is a DockerError with code 2 (cannot verify). `reason` says why Docker or the
 * image is not ready: docker-not-installed, docker-not-running, image-missing or pull-failed.
 *
 * Node standard library only, plus docker.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export const PULL_TIMEOUT_MS = 15 * 60 * 1000; // CI's `--pull`: a runner has no one waiting
export const PREFLIGHT_PULL_TIMEOUT_MS = 5 * 60 * 1000; // a person is waiting: past this, say so and let them run it again (Docker keeps what it fetched)
// A name that could be read as a docker option is refused.
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;

export class DockerError extends Error {
  // `reason` names why Docker or the image is not ready, for the caller to ask the right question.
  constructor(message, reason = null) { super(message); this.code = 2; this.reason = reason; }
}

export const isImageName = (name) => name.search(IMAGE_NAME) !== -1;
export const tailOf = (text) => String(text || '').trim().split('\n').slice(-6).map((l) => `    ${l}`).join('\n');

/**
 * Docker is there, running, and holds `image`; fetch it first only where the caller said to.
 * `show` lets Docker's own progress reach the person (the preflight); the scan fetches quietly.
 * `label` names the image for a person, and `size` says how big the first fetch is.
 * Returns 'present' or 'pulled'.
 */
export function ensureImage({ image, pull, env, show = false, pullTimeoutMs = PULL_TIMEOUT_MS, label, size = null }) {
  const has = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { env, encoding: 'utf8', timeout: 60 * 1000 });
  if (has.error) {
    throw new DockerError(has.error.code === 'ENOENT'
      ? 'Docker is not installed (there is no `docker` on the PATH); install it from https://docs.docker.com/get-docker/'
      : `docker could not run: ${has.error.message}`, has.error.code === 'ENOENT' ? 'docker-not-installed' : 'docker-not-running');
  }
  if (has.status === 0) return 'present';
  const said = String(has.stderr || '').trim().split('\n')[0];
  if (said.search(/No such image/i) === -1) throw new DockerError(`Docker is not running or cannot be used: ${said || `docker exited ${has.status}`}`, 'docker-not-running');
  if (!pull) throw new DockerError(`the ${label} image is not on this machine yet; fetch it once with: docker pull ${image}`, 'image-missing');
  let got;
  if (show) {
    process.stderr.write(`Fetching ${image} (${size ? `about ${size}, ` : ''}once on this machine). Docker's progress follows.\n`);
    got = spawnSync('docker', ['pull', image], { env, stdio: ['ignore', 2, 2], timeout: pullTimeoutMs });
  } else {
    got = spawnSync('docker', ['pull', '--quiet', image], { env, encoding: 'utf8', timeout: pullTimeoutMs });
  }
  if (got.error || got.status !== 0) {
    const slow = got.error && got.error.code === 'ETIMEDOUT';
    const why = slow
      ? `did not finish within ${Math.round(pullTimeoutMs / 1000)} s; run the command again to carry on (Docker keeps what it has fetched), or fetch it yourself with: docker pull ${image}`
      : `failed${got.error ? `: ${got.error.message}` : show ? ` (exit ${got.status}; Docker's own words are above)` : `:\n${tailOf(got.stderr)}`}`;
    throw new DockerError(`docker pull ${image} ${why}`, 'pull-failed');
  }
  return 'pulled';
}

/**
 * `command` in a container that can read the mounts, write only the ones marked writable, and reach nothing.
 * `mounts` is [{ src, dst, writable }], `env` a record of `-e` values. The image comes right before `command`.
 */
export function runContainer({ image, name, mounts, env, workdir, command, spawnEnv, timeoutMs }) {
  const mount = ({ src, dst, writable = false }) => ['--mount', `type=bind,src=${realpathSync(src)},dst=${dst}${writable ? '' : ',readonly'}`];
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  const args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp', ...user, '-e', 'HOME=/tmp', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...mounts.flatMap(mount), '-w', workdir,
    image, ...command];
  const res = spawnSync('docker', args, { env: spawnEnv, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
  // A killed client can leave its container running.
  if (res.error || res.signal) spawnSync('docker', ['rm', '-f', name], { env: spawnEnv, stdio: 'ignore' });
  return res;
}
