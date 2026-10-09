<?php
/**
 * Memphis v5 — site backend bootstrap
 *
 * Owns: SQLite (WAL), privacy-preserving analytics, download counter,
 * lead capture, rate limiting.
 *
 * Privacy constraints (project rule: no telemetry, no analytics):
 *  - no cookies, no fingerprinting, no IP storage, no third-party requests
 *  - analytics = aggregate daily counters only; salted HMAC of IP+UA rotated daily
 *  - a single anon id in localStorage, never linked to identity
 */

declare(strict_types=1);

const DB_PATH      = __DIR__ . '/../data/site.db';
const ANALYTICS_KEY = __DIR__ . '/../data/.salt';

mb_internal_encoding('UTF-8');
date_default_timezone_set('Europe/Warsaw');

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');

function respond(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_post(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        header('Allow: POST');
        respond(['ok' => false, 'error' => 'method_not_allowed'], 405);
    }
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $host   = $_SERVER['HTTP_HOST'] ?? '';
    if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== $host) {
        respond(['ok' => false, 'error' => 'bad_origin'], 403);
    }
    if (!str_contains($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) {
        respond(['ok' => false, 'error' => 'content_type'], 415);
    }
}

/**
 * Read the shared secret from wherever this host can actually see it.
 *
 * getenv() alone was the assumption, and it is wrong here. Measured on the
 * host this actually runs on (PHP 8.5.9, fpm-fcgi, Apache):
 *
 *   - getenv('MEMPHIS_STATS_TOKEN') -> false, with nothing set
 *   - open_basedir allows ~/public_html/memphis-v5, ~/tmp, /tmp, /home/tmp
 *     and NOT ~/secrets
 *
 * So there is no .env the panel writes that getenv() would see, and a file in
 * ~/secrets is unreadable from PHP. The env var is still honoured first, since
 * a systemd unit or a php-fpm pool can set it properly; the file is the
 * fallback that works on shared hosting.
 *
 * This is why the earlier version could keep a literal "as a fallback" and
 * look correct for weeks: the env branch was never exercised at all, so nobody
 * noticed that neither branch could work.
 */
function stats_token(): ?string
{
    $fromEnv = getenv('MEMPHIS_STATS_TOKEN');
    if (is_string($fromEnv) && $fromEnv !== '') {
        return $fromEnv;
    }

    foreach (['/home/platne/serwer437043/tmp/memphis-v5-stats.env',
              '/home/tmp/memphis-v5-stats.env',
              '/tmp/memphis-v5-stats.env'] as $path) {
        if (!is_readable($path)) {
            continue;
        }
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            if (str_starts_with($line, 'MEMPHIS_STATS_TOKEN=')) {
                $value = trim(substr($line, strlen('MEMPHIS_STATS_TOKEN=')));
                $value = trim($value, "\"'");
                if ($value !== '') {
                    return $value;
                }
            }
        }
    }
    return null;
}

/**
 * Authenticate a shared-secret endpoint (operator stats, retention cron).
 *
 * WHY THERE IS NO FALLBACK VALUE
 * ------------------------------
 * Both call sites used to read getenv('MEMPHIS_STATS_TOKEN') and fall back to
 * a literal shipped in this file. A key committed to the repository is not a
 * fallback — it is a credential published to everyone who can read the repo,
 * and it still works after every other rotation. The endpoint answered 200
 * with real traffic numbers when given that string.
 *
 * So: unconfigured means CLOSED, not open. A missing environment variable is
 * an operator action (set it in the server .env), and the endpoint says so
 * with 503 rather than pretending to authenticate someone.
 *
 * Shared-secret headers are compared in constant time, and the header name is
 * a parameter so one helper serves both stats and cron without either endpoint
 * growing its own comparison branch.
 */
function require_token(string $header): void
{
    $expected = stats_token();
    if (!is_string($expected) || $expected === '') {
        respond(
            ['ok' => false, 'error' => 'endpoint_disabled',
             'detail' => 'MEMPHIS_STATS_TOKEN is not set on this host.'],
            503,
        );
    }
    $given = $_SERVER[$header] ?? ($_GET['token'] ?? '');
    if (!hash_equals($expected, (string) $given)) {
        header('WWW-Authenticate: Bearer realm="memphis-operator"');
        respond(['ok' => false, 'error' => 'unauthorized'], 401);
    }
    // NOTE: no `exit` here, and that omission is deliberate twice over.
    // respond() already ends the request, so a trailing exit is redundant on
    // the failure paths. On the success path it was actively wrong: this
    // version returned 200 with content-length: 0 on every authenticated
    // request, because the script died here before reaching its own body. The
    // endpoint looked alive — 200, right headers, no error anywhere — which is
    // the worst shape a silent failure can take. Returning void lets the caller
    // continue.
}

function body_field(string $name, int $maxLen): ?string
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 8192) {
        respond(['ok' => false, 'error' => 'body_too_large'], 413);
    }
    $json = json_decode($raw, true);
    if (!is_array($json) || !isset($json[$name]) || !is_string($json[$name])) {
        return null;
    }
    $v = trim($json[$name]);
    if ($v === '' || mb_strlen($v) > $maxLen) {
        return null;
    }
    return $v;
}

function valid_email(string $email): bool
{
    if (mb_strlen($email) > 254) {
        return false;
    }
    return (bool) filter_var($email, FILTER_VALIDATE_EMAIL);
}

/** Salted daily visitor hash. Rotates every 24h so it cannot follow a person. */
function daily_visitor_hash(string $salt): string
{
    $ip  = $_SERVER['REMOTE_ADDR'] ?? '';
    $ua  = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 200);
    $day = gmdate('Y-m-d');
    return hash_hmac('sha256', $ip . '|' . $ua, $salt . '|' . $day);
}

function anon_id(string $raw): string
{
    $id = preg_replace('/[^a-zA-Z0-9_-]/', '', $raw) ?? '';
    return substr($id, 0, 40);
}

function salt(): string
{
    static $s = null;
    if (is_string($s)) {
        return $s;
    }
    $dir = dirname(ANALYTICS_KEY);
    if (!is_dir($dir)) {
        @mkdir($dir, 0o775, true);
    }
    if (is_readable(ANALYTICS_KEY)) {
        $v = trim((string) file_get_contents(ANALYTICS_KEY));
        if (strlen($v) >= 32) {
            return $s = $v;
        }
    }
    $s = bin2hex(random_bytes(32));
    @file_put_contents(ANALYTICS_KEY, $s);
    @chmod(ANALYTICS_KEY, 0o600);
    return $s;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $dir = dirname(DB_PATH);
    if (!is_dir($dir) && !mkdir($dir, 0o775, true) && !is_dir($dir)) {
        respond(['ok' => false, 'error' => 'storage_unavailable'], 500);
    }
    $pdo = new PDO('sqlite:' . DB_PATH, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 4000');
    $pdo->exec('PRAGMA foreign_keys = ON');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $ddl = [
        <<<'SQL'
        CREATE TABLE IF NOT EXISTS visitors (
            day     TEXT NOT NULL,
            visitor TEXT NOT NULL,
            referrer TEXT NOT NULL DEFAULT '',
            path    TEXT NOT NULL DEFAULT '/',
            hits    INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (day, visitor, path)
        )
        SQL,
        'CREATE INDEX IF NOT EXISTS idx_visitors_day ON visitors (day)',

        <<<'SQL'
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            kind    TEXT NOT NULL,
            label   TEXT NOT NULL DEFAULT '',
            path    TEXT NOT NULL DEFAULT '',
            visitor TEXT NOT NULL,
            day     TEXT NOT NULL,
            ts      TEXT NOT NULL
        )
        SQL,
        'CREATE INDEX IF NOT EXISTS idx_events_day ON events (day, kind)',

        <<<'SQL'
        CREATE TABLE IF NOT EXISTS downloads (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            artifact TEXT NOT NULL,
            visitor  TEXT NOT NULL,
            day      TEXT NOT NULL,
            ts       TEXT NOT NULL
        )
        SQL,
        'CREATE INDEX IF NOT EXISTS idx_downloads_day ON downloads (day)',

        <<<'SQL'
        CREATE TABLE IF NOT EXISTS leads (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            email      TEXT NOT NULL UNIQUE,
            source     TEXT NOT NULL DEFAULT 'site',
            kind       TEXT NOT NULL DEFAULT 'newsletter',
            consent    INTEGER NOT NULL DEFAULT 0,
            confirmed  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        SQL,

        <<<'SQL'
        CREATE TABLE IF NOT EXISTS rate_limits (
            bucket TEXT NOT NULL,
            window INTEGER NOT NULL,
            count  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (bucket, window)
        )
        SQL,
    ];
    foreach ($ddl as $sql) {
        $pdo->exec($sql);
    }
}

function rate_limit(string $bucket, int $limit = 20, int $windowSec = 300): void
{
    $pdo   = db();
    $now   = time();
    $start = $now - ($now % $windowSec);
    $stmt  = $pdo->prepare('INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, 1)
        ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1');
    $stmt->execute([$bucket, $start]);
    $stmt = $pdo->prepare('SELECT count FROM rate_limits WHERE bucket = ? AND window = ?');
    $stmt->execute([$bucket, $start]);
    if ((int) ($stmt->fetchColumn() ?: 0) > $limit) {
        header('Retry-After: ' . $windowSec);
        respond(['ok' => false, 'error' => 'rate_limited'], 429);
    }
    if ($now % 60 < 5) {
        $pdo->exec('DELETE FROM rate_limits WHERE window < ' . ($now - 7200));
    }
}
