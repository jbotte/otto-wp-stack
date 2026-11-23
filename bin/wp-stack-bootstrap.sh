#!/usr/bin/env bash
# otto-wp-stack bootstrap — one-time runtime install for this Otto.
#
# Downloads and installs this stack's OWN runtime into the stack folder:
#   runtime/php            static PHP CLI (static-php.dev build)
#   runtime/wp-cli.phar    WP-CLI
#   runtime/mariadb/       MariaDB bintar (our own server, our own datadir)
# then initialises the database and creates the stack-scoped mysql user
# (grants limited to `wps_%` databases). NO SUDO, NO SYSTEMD, NO APT:
# everything runs and lives as the Otto agent user under $STACK_ROOT.
#
# Usage:  bin/wp-stack-bootstrap.sh            (defaults)
#         WP_STACK_ROOT=/path bin/wp-stack-bootstrap.sh
set -euo pipefail

STACK_ROOT="${WP_STACK_ROOT:-$HOME/otto-wp-stack}"
DB_PORT="${WP_STACK_DB_PORT:-3307}"
DB_USER="${WP_STACK_DB_USER:-wp_stack}"
PHP_VERSION="8.3.13"
# bulk preset: includes mysqli, which WordPress core requires (the "common" preset does not)
PHP_URL="https://dl.static-php.dev/static-php-cli/bulk/php-${PHP_VERSION}-cli-linux-x86_64.tar.gz"
WPCLI_URL="https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar"
DB_VERSION="11.4.5"
DB_URL="https://archive.mariadb.org/mariadb-${DB_VERSION}/bintar-linux-systemd-x86_64/mariadb-${DB_VERSION}-linux-systemd-x86_64.tar.gz"

RT="$STACK_ROOT/runtime"
DB_DATA="$STACK_ROOT/db/data"
RUN="$STACK_ROOT/run"
LOGS="$STACK_ROOT/logs"
SOCK="$RUN/mysql.sock"

log() { printf '[wp-stack] %s\n' "$*"; }
die() { printf '[wp-stack] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" != "0" ] || die "do not run this as root — run as the Otto agent user"
command -v curl >/dev/null || die "curl is required"
command -v tar  >/dev/null || die "tar is required"

mkdir -p "$RT" "$DB_DATA" "$RUN" "$LOGS" "$STACK_ROOT/sites"

# ---------------------------------------------------------------------------
# 1) PHP (static build)
# ---------------------------------------------------------------------------
if [ -x "$RT/php" ] && "$RT/php" -v >/dev/null 2>&1; then
  log "php: present ($("$RT/php" -v | head -1))"
else
  log "php: downloading static build ${PHP_VERSION}…"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/php.tgz" "$PHP_URL"
  tar -xzf "$tmp/php.tgz" -C "$tmp"
  phpbin="$(find "$tmp" -maxdepth 2 -type f -name php | head -1)"
  [ -n "$phpbin" ] || die "php binary not found in the download"
  install -m 0755 "$phpbin" "$RT/php"
  "$RT/php" -v >/dev/null || die "downloaded php does not run"
  log "php: installed ($("$RT/php" -v | head -1))"
fi

# ---------------------------------------------------------------------------
# 2) WP-CLI phar
# ---------------------------------------------------------------------------
if [ -s "$RT/wp-cli.phar" ] && "$RT/php" "$RT/wp-cli.phar" --version --allow-root >/dev/null 2>&1; then
  log "wp-cli: present"
else
  log "wp-cli: downloading…"
  curl -fL --retry 3 --connect-timeout 15 -o "$RT/wp-cli.phar.part" "$WPCLI_URL"
  mv "$RT/wp-cli.phar.part" "$RT/wp-cli.phar"
  "$RT/php" "$RT/wp-cli.phar" --version --allow-root >/dev/null || die "wp-cli.phar does not run"
  log "wp-cli: installed"
fi

# ---------------------------------------------------------------------------
# 3) MariaDB bintar (our own server)
# ---------------------------------------------------------------------------
if [ -x "$RT/mariadb/bin/mariadbd" ]; then
  log "mariadb: present ($("$RT/mariadb/bin/mariadbd" --version))"
else
  log "mariadb: downloading ${DB_VERSION} bintar (~550 MB, may take a few minutes)…"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/db.tgz" "$DB_URL"
  mkdir -p "$RT/mariadb"
  tar -xzf "$tmp/db.tgz" -C "$RT/mariadb" --strip-components=1
  [ -x "$RT/mariadb/bin/mariadbd" ] || die "mariadbd missing after extract"
  log "mariadb: installed ($("$RT/mariadb/bin/mariadbd" --version))"
fi

start_db() {
  if "$RT/mariadb/bin/mariadb-admin" --protocol=TCP -h127.0.0.1 -P"$DB_PORT" -u"$DB_USER" -p"$(cred_pass)" ping >/dev/null 2>&1; then
    return 0
  fi
  log "db: starting mariadbd on 127.0.0.1:${DB_PORT}…"
  nohup "$RT/mariadb/bin/mariadbd" \
    --datadir="$DB_DATA" --socket="$SOCK" --pid-file="$RUN/mysqld.pid" \
    --bind-address=127.0.0.1 --port="$DB_PORT" --skip-name-resolve \
    --log-error="$LOGS/mariadb.log" >>"$LOGS/mariadb.log" 2>&1 &
  for _ in $(seq 1 60); do
    if "$RT/mariadb/bin/mariadb-admin" --protocol=socket --socket="$SOCK" -uroot ping >/dev/null 2>&1 \
      || "$RT/mariadb/bin/mariadb-admin" --protocol=TCP -h127.0.0.1 -P"$DB_PORT" -u"$DB_USER" -p"$(cred_pass)" ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  die "mariadbd did not come up — see $LOGS/mariadb.log"
}

cred_pass() {
  if [ -s "$STACK_ROOT/.db-credential" ]; then
    sed -n 's/.*"password":[[:space:]]*"\([^"]*\)".*/\1/p' "$STACK_ROOT/.db-credential" | head -1
  fi
}

# ---------------------------------------------------------------------------
# 4) Initial data directory
# ---------------------------------------------------------------------------
if [ ! -d "$DB_DATA/mysql" ]; then
  log "db: initialising datadir…"
  "$RT/mariadb/scripts/mariadb-install-db" \
    --user="$(id -un)" --basedir="$RT/mariadb" --datadir="$DB_DATA" \
    --auth-root-authentication-method=normal --skip-test-db >/dev/null
else
  log "db: datadir already initialised"
fi

start_db

# ---------------------------------------------------------------------------
# 5) Stack-scoped mysql user + credential file
# ---------------------------------------------------------------------------
if [ ! -s "$STACK_ROOT/.db-credential" ]; then
  log "db: creating user '${DB_USER}' (grants limited to wps_%% databases)…"
  PASS="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  "$RT/mariadb/bin/mariadb" --protocol=socket --socket="$SOCK" -uroot <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${PASS}';
GRANT ALL PRIVILEGES ON \`wps\_%\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
  ( umask 077; printf '{\n  "user": "%s",\n  "password": "%s",\n  "socket": "%s",\n  "port": %s\n}\n' "$DB_USER" "$PASS" "$SOCK" "$DB_PORT" > "$STACK_ROOT/.db-credential" )
  log "db: credential written to $STACK_ROOT/.db-credential (mode 600)"
else
  log "db: credential file already present"
  start_db
fi

# verify the stack user can actually work in its own prefix
"$RT/mariadb/bin/mariadb" --protocol=TCP -h127.0.0.1 -P"$DB_PORT" -u"$DB_USER" -p"$(cred_pass)" \
  -e "CREATE DATABASE IF NOT EXISTS wps_bootstrap_probe; DROP DATABASE wps_bootstrap_probe;" \
  || die "stack db user cannot create wps_* databases — check grants"

log "done. Runtime is ready under $STACK_ROOT"
log "next: 1) openclaw plugins install --link <plugin folder>   2) enable + restart the Gateway"
log "      3) paste the plugin's .api-token into the WP Stack app Settings"
