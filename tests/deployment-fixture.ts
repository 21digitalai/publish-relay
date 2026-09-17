import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function writeExecutable(path: string, content: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
  chmodSync(path, 0o755);
}

export function createDeployFixture(): {
  environment: NodeJS.ProcessEnv;
  source: string;
  currentLink: string;
  log: string;
  nodeBin: string;
  releaseRoot: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'publish-relay-deploy-')));
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const log = join(root, 'commands.log');
  const currentLink = join(root, 'current');
  const releaseRoot = join(root, 'releases');
  mkdirSync(bin);
  mkdirSync(releaseRoot);
  mkdirSync(join(source, 'migrations'), { recursive: true });
  mkdirSync(join(source, 'dist', 'database'), { recursive: true });
  mkdirSync(join(source, 'deploy'), { recursive: true });
  writeFileSync(join(source, 'package-lock.json'), '{}');
  writeFileSync(join(source, 'dist', 'database', 'migrate.js'), '');
  writeFileSync(join(source, 'deploy', 'bootstrap-database-authorities.sql'), '');
  writeExecutable(join(bin, 'install'), 'mkdir -p "${@: -1}"');
  writeExecutable(join(bin, 'chown'), 'exit 0');
  writeExecutable(
    join(bin, 'mv'),
    `echo "mv $*" >> "$COMMAND_LOG"; [[ "$1" == "-Tf" ]] && shift; "$REAL_NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$@"`,
  );
  writeExecutable(
    join(bin, 'sudo'),
    'preserve=""; while [[ "$1" == --* ]]; do case "$1" in --chdir=*|-D) echo "sudo: hardened policy rejects chdir" >&2; exit 1 ;; --preserve-env=*) preserve="${1#*=}" ;; esac; shift; done; [[ "$1" == "-u" ]] && shift 2; base=(env -i PATH="$PATH" COMMAND_LOG="$COMMAND_LOG" FAIL_MIGRATION="${FAIL_MIGRATION:-0}" FAIL_BOOTSTRAP="${FAIL_BOOTSTRAP:-0}" NPM_REMOVES_DIST="${NPM_REMOVES_DIST:-0}"); if [[ "$preserve" == "DATABASE_URL,PGPASSWORD" ]]; then exec "${base[@]}" DATABASE_URL="${DATABASE_URL:-}" PGPASSWORD="${PGPASSWORD:-}" "$@"; elif [[ "$preserve" == "PGPASSWORD" ]]; then exec "${base[@]}" PGPASSWORD="${PGPASSWORD:-}" "$@"; else exec "${base[@]}" "$@"; fi',
  );
  const nodeBin = join(bin, 'node24');
  const npmCli = join(bin, 'npm-cli.js');
  writeFileSync(npmCli, 'fixture npm CLI');
  writeExecutable(
    nodeBin,
    'if [[ "$1" == *release-filesystem.mjs ]]; then exec "$REAL_NODE" "$@"; fi; if [[ "$1" == "--version" ]]; then echo v24.8.0; exit 0; fi; [[ "$1" == *"npm-cli.js" ]] && { shift; echo "npm $*" >> "$COMMAND_LOG"; [[ "${NPM_REMOVES_DIST:-0}" == 1 ]] && rm -rf "${@: -1}/dist"; exit 0; }; echo "node=$0 cwd=$PWD script=$1 database=$([[ -n "${DATABASE_URL:-}" ]] && echo set || echo missing) password=$([[ -n "${PGPASSWORD:-}" ]] && echo set || echo missing)" >> "$COMMAND_LOG"; [[ "${FAIL_MIGRATION:-0}" != 1 ]]',
  );
  const psqlBin = join(bin, 'psql');
  writeExecutable(
    psqlBin,
    'echo "psql cwd=$PWD pgdatabase=$([[ -n "${PGDATABASE:-}" ]] && echo set || echo missing) password=$([[ -n "${PGPASSWORD:-}" ]] && echo set || echo missing) $*" >> "$COMMAND_LOG"; [[ "${FAIL_BOOTSTRAP:-0}" != 1 ]]',
  );
  writeExecutable(join(bin, 'ln'), 'echo "ln $*" >> "$COMMAND_LOG"; command /bin/ln "$@"');
  writeExecutable(
    join(bin, 'systemctl'),
    'echo "systemctl $*" >> "$COMMAND_LOG"; if [[ "$1" == show ]]; then echo 12345; fi; if [[ "$1" == restart && "${FAIL_RESTART:-0}" == 1 ]]; then exit 1; fi',
  );
  writeExecutable(
    join(bin, 'readlink'),
    'if [[ "$1" == -f && "$2" == /proc/*/cwd ]]; then if [[ "${PROCESS_MISMATCH:-0}" == 1 ]]; then echo /wrong/release; else /usr/bin/readlink "$PUBLISH_RELAY_CURRENT_LINK"; fi; else /usr/bin/readlink "$@"; fi',
  );
  writeExecutable(
    join(bin, 'lsof'),
    'if [[ "${LSOF_ERROR:-0}" == 1 ]]; then echo "observation failed" >&2; exit 1; fi; if [[ "${OLD_IN_USE:-0}" == 1 ]]; then echo 12346; exit 0; fi; exit 1',
  );
  writeExecutable(
    join(bin, 'curl'),
    'echo "curl $*" >> "$COMMAND_LOG"; attempt_file="${CURL_ATTEMPT_FILE:-$COMMAND_LOG.curl-attempts}"; attempt=0; [[ -f "$attempt_file" ]] && attempt="$(cat "$attempt_file")"; attempt=$((attempt + 1)); echo "$attempt" > "$attempt_file"; [[ "${FAIL_READINESS:-0}" != 1 && "$(/usr/bin/readlink "$PUBLISH_RELAY_CURRENT_LINK")" != *"${FAIL_RELEASE:-never-match}" && "$attempt" -ge "${READINESS_SUCCEEDS_ON_ATTEMPT:-1}" ]]',
  );
  return {
    environment: {
      ...process.env,
      REAL_NODE: process.execPath,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      COMMAND_LOG: log,
      PUBLISH_RELAY_RELEASE_ROOT: releaseRoot,
      PUBLISH_RELAY_CURRENT_LINK: currentLink,
      PUBLISH_RELAY_SERVICE_USER: 'test-user',
      PUBLISH_RELAY_NODE_BIN: nodeBin,
      PUBLISH_RELAY_NPM_CLI: npmCli,
      PUBLISH_RELAY_PSQL_BIN: psqlBin,
      PUBLISH_RELAY_HEALTH_URL: 'http://127.0.0.1:3999/health/ready',
      PUBLISH_RELAY_HEALTH_ATTEMPTS: '3',
      PUBLISH_RELAY_HEALTH_INTERVAL_SECONDS: '0',
      MIGRATION_DATABASE_URL: 'postgresql://migrator@127.0.0.1/publish_relay',
      PGPASSWORD: 'fixture-password',
    },
    source,
    currentLink,
    log,
    nodeBin,
    releaseRoot,
  };
}
