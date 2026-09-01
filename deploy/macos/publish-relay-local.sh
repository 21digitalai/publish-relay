#!/usr/bin/env bash
set -euo pipefail
action="${1:-}"
case "$action" in install|start|stop|restart|status|uninstall) ;; *) echo "usage: $0 install|start|stop|restart|status|uninstall" >&2; exit 64;; esac
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
runtime_root="${PUBLISH_RELAY_LOCAL_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/publish-relay}"
postgres_port="${PUBLISH_RELAY_POSTGRES_PORT:-55436}"; web_port="${PUBLISH_RELAY_PORT:-3106}"
node_bin="${PUBLISH_RELAY_NODE_BIN:-$(command -v node || true)}"
nexus_bin="$(command -v nexus || true)"
pg_bin="${PUBLISH_RELAY_POSTGRES_BIN:-$(brew --prefix postgresql@17 2>/dev/null)/bin}"
domain="gui/$(id -u)"; plist_dir="$runtime_root/launchd"; log_dir="$runtime_root/logs"; data_dir="$runtime_root/postgres"; media_dir="$runtime_root/media"
labels=(local.publish-relay.postgres local.publish-relay.web local.publish-relay.worker)
require_file(){ [[ -e "$1" ]] || { echo "missing required file: $1" >&2; exit 69; }; }
require_runtime(){ for f in "$node_bin" "$nexus_bin" "$pg_bin/initdb" "$pg_bin/pg_ctl" "$pg_bin/psql" "$project_root/dist/entrypoints/web.js" "$project_root/dist/entrypoints/worker.js" "$project_root/dist/database/migrate.js"; do require_file "$f"; done; }
plist_path(){ printf '%s/%s.plist' "$plist_dir" "$1"; }
bootout(){ launchctl bootout "$domain/$(basename "$1" .plist)" >/dev/null 2>&1 || true; }
write_plist(){ local label="$1" program="$2" out="$3" err="$4"; shift 4; { printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict>'; printf '<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array>\n<string>%s</string>\n' "$label" "$program"; for arg in "$@"; do printf '<string>%s</string>\n' "$arg"; done; printf '%s\n' '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>LC_ALL</key><string>C</string></dict>'; printf '<key>StandardOutPath</key><string>%s</string>\n<key>StandardErrorPath</key><string>%s</string>\n</dict></plist>\n' "$out" "$err"; } >"$(plist_path "$label")"; plutil -lint "$(plist_path "$label")" >/dev/null; }
write_wrapper(){ local mode="$1"; local wrapper="$runtime_root/run-$mode.sh"; { printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'; printf 'export PATH=%q:/opt/homebrew/bin:/usr/bin:/bin\n' "$(dirname "$node_bin")"; printf 'cd %q\n' "$project_root"; printf 'exec %q credentials run publish-relay/local-master-key publish-relay/local-cursor-secret -- env NODE_ENV=development HOST=127.0.0.1 PORT=%q DATABASE_URL=%q WORKER_DATABASE_URL=%q MEDIA_STORAGE_ROOT=%q PUBLISH_RELAY_MASTER_KEY_ACTIVE_VERSION=V1 PUBLISH_RELAY_X_CONSUMER_KEY=local-fake-consumer PUBLISH_RELAY_X_CONSUMER_SECRET=local-fake-secret PUBLISH_RELAY_PUBLIC_ORIGIN=http://127.0.0.1:%q %q %q\n' "$nexus_bin" "$web_port" "postgresql://publish_relay_web_login@127.0.0.1:$postgres_port/publish_relay" "postgresql://publish_relay_worker_login@127.0.0.1:$postgres_port/publish_relay" "$media_dir" "$web_port" "$node_bin" "$project_root/dist/entrypoints/$mode.js"; } >"$wrapper"; chmod 700 "$wrapper"; }
initialize_database(){ if [[ ! -f "$data_dir/PG_VERSION" ]]; then "$pg_bin/initdb" -D "$data_dir" --auth-host=trust --auth-local=trust >/dev/null; printf '\nport = %s\nlisten_addresses = '\''127.0.0.1'\''\n' "$postgres_port" >>"$data_dir/postgresql.conf"; fi; "$pg_bin/pg_ctl" -D "$data_dir" -l "$log_dir/postgres-bootstrap.log" start -w >/dev/null; "$pg_bin/psql" -h 127.0.0.1 -p "$postgres_port" postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='publish_relay_migrator_login') THEN CREATE ROLE publish_relay_migrator_login LOGIN; END IF;
IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='publish_relay_web_login') THEN CREATE ROLE publish_relay_web_login LOGIN; END IF;
IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='publish_relay_worker_login') THEN CREATE ROLE publish_relay_worker_login LOGIN; END IF;
END $$;
SELECT 'CREATE DATABASE publish_relay OWNER publish_relay_migrator_login' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='publish_relay')\gexec
SQL
DATABASE_URL="postgresql://publish_relay_migrator_login@127.0.0.1:$postgres_port/publish_relay" "$node_bin" "$project_root/dist/database/migrate.js"
"$pg_bin/psql" -h 127.0.0.1 -p "$postgres_port" -d publish_relay -v ON_ERROR_STOP=1 -f "$project_root/deploy/bootstrap-database-authorities.sql"
"$pg_bin/psql" -h 127.0.0.1 -p "$postgres_port" postgres -v ON_ERROR_STOP=1 -c 'GRANT publish_relay_web TO publish_relay_web_login; GRANT publish_relay_worker TO publish_relay_worker_login;'
"$pg_bin/pg_ctl" -D "$data_dir" stop -m fast -w >/dev/null; }
install_runtime(){ require_runtime; mkdir -p "$plist_dir" "$log_dir" "$media_dir"; for label in "${labels[@]}"; do bootout "$(plist_path "$label")"; done; initialize_database; write_wrapper web; write_wrapper worker; write_plist "${labels[0]}" "$pg_bin/postgres" "$log_dir/postgres.log" "$log_dir/postgres-error.log" -D "$data_dir" -p "$postgres_port"; write_plist "${labels[1]}" "$runtime_root/run-web.sh" "$log_dir/web.log" "$log_dir/web-error.log"; write_plist "${labels[2]}" "$runtime_root/run-worker.sh" "$log_dir/worker.log" "$log_dir/worker-error.log"; }
start_runtime(){ require_runtime; for label in "${labels[@]}"; do bootout "$(plist_path "$label")"; launchctl bootstrap "$domain" "$(plist_path "$label")"; done; for _ in {1..30}; do curl --fail --silent "http://127.0.0.1:$web_port/health/ready" >/dev/null && return; sleep 1; done; echo "not ready; inspect $log_dir" >&2; exit 70; }
stop_runtime(){ for label in "${labels[@]}"; do bootout "$(plist_path "$label")"; done; for _ in {1..30}; do "$pg_bin/pg_ctl" -D "$data_dir" status >/dev/null 2>&1 || return; sleep 1; done; echo "PostgreSQL did not stop cleanly" >&2; exit 70; }
status_runtime(){ local failed=0; for label in "${labels[@]}"; do launchctl print "$domain/$label" >/dev/null 2>&1 && echo "$label: running" || { echo "$label: stopped"; failed=1; }; done; curl --fail --silent "http://127.0.0.1:$web_port/health/ready" >/dev/null && echo 'health: ready' || { echo 'health: unavailable'; failed=1; }; return "$failed"; }
case "$action" in install) install_runtime; start_runtime;; start) start_runtime;; stop) stop_runtime;; restart) stop_runtime; start_runtime;; status) status_runtime;; uninstall) stop_runtime; echo "runtime data preserved at $runtime_root";; esac
