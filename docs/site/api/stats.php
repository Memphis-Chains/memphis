<?php
/**
 * GET /api/stats.php?days=30
 *
 * Operator-facing aggregate. No visitor-level data is exposed:
 * every figure is a COUNT over a window. No IP, no anon id, no referrer path.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    respond(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

// Operator-only. Without this the funnel is public: anyone could read
// visitor counts and lead totals. Token is a constant-time comparison.
// getenv() is not allowed in a const expression, so resolve it at runtime.
$token = getenv('MEMPHIS_STATS_TOKEN');
if (!is_string($token) || $token === '') {
    $token = 'memphis-local-stats-2026';
}
$given = $_SERVER['HTTP_X_STATS_TOKEN'] ?? ($_GET['token'] ?? '');
if (!hash_equals($token, (string) $given)) {
    header('WWW-Authenticate: Bearer realm="memphis-stats"');
    respond(['ok' => false, 'error' => 'unauthorized'], 401);
}

$days = (int) ($_GET['days'] ?? 30);
$days = max(1, min($days, 365));

$pdo  = db();
$from = gmdate('Y-m-d', time() - ($days * 86400));

$stmt = $pdo->prepare('SELECT COUNT(DISTINCT visitor) AS visitors, SUM(hits) AS pageviews
                       FROM visitors WHERE day >= ?');
$stmt->execute([$from]);
$traffic = $stmt->fetch() ?: ['visitors' => 0, 'pageviews' => 0];

$stmt = $pdo->prepare('SELECT kind, COUNT(*) AS n FROM events
                       WHERE day >= ? AND kind != "pageview" GROUP BY kind ORDER BY n DESC');
$stmt->execute([$from]);
$events = [];
foreach ($stmt->fetchAll() as $r) {
    $events[$r['kind']] = (int) $r['n'];
}

$stmt = $pdo->prepare('SELECT artifact, COUNT(*) AS n FROM downloads
                       WHERE day >= ? GROUP BY artifact ORDER BY n DESC');
$stmt->execute([$from]);
$downloads = [];
foreach ($stmt->fetchAll() as $r) {
    $downloads[$r['artifact']] = (int) $r['n'];
}

$stmt = $pdo->prepare('SELECT day, COUNT(DISTINCT visitor) AS n FROM visitors
                       WHERE day >= ? GROUP BY day ORDER BY day');
$stmt->execute([$from]);
$series = array_map(
    static fn(array $r): array => ['day' => $r['day'], 'visitors' => (int) $r['n']],
    $stmt->fetchAll()
);

$stmt = $pdo->prepare('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?');
$stmt->execute([$from]);
$leads = (int) ($stmt->fetchColumn() ?: 0);

$stmt = $pdo->prepare('SELECT referrer, COUNT(DISTINCT visitor) AS n FROM visitors
                       WHERE day >= ? AND referrer != "" GROUP BY referrer
                       ORDER BY n DESC LIMIT 12');
$stmt->execute([$from]);
$referrers = array_map(
    static fn(array $r): array => ['host' => $r['referrer'], 'visitors' => (int) $r['n']],
    $stmt->fetchAll()
);

$visitors = (int) ($traffic['visitors'] ?? 0);
$funnel = [
    'visitors'  => $visitors,
    'install'   => (int) ($downloads['install.sh'] ?? 0),
    'lead'      => $leads,
];
$funnel['install_rate'] = $visitors > 0
    ? round($funnel['install'] / $visitors * 100, 2) : 0.0;
$funnel['lead_rate'] = $visitors > 0
    ? round($funnel['lead'] / $visitors * 100, 2) : 0.0;

respond([
    'ok'        => true,
    'window'    => ['days' => $days, 'from' => $from, 'to' => gmdate('Y-m-d')],
    'traffic'   => [
        'visitors'  => $visitors,
        'pageviews' => (int) ($traffic['pageviews'] ?? 0),
    ],
    'events'    => $events,
    'downloads' => $downloads,
    'leads'     => $leads,
    'funnel'    => $funnel,
    'series'    => $series,
    'referrers' => $referrers,
]);
