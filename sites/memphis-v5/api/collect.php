<?php
/**
 * POST /api/collect.php
 * Body: { kind, label?, path?, visitor? }
 *
 * Records a pageview or a named conversion event.
 * kind must be in the allowlist. Nothing else is accepted.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

require_post();

$kind = body_field('kind', 24);
if ($kind === null) {
    respond(['ok' => false, 'error' => 'invalid_kind'], 422);
}

const KINDS = ['pageview', 'copy', 'download', 'cta', 'newsletter', 'chat', 'play', 'expand', 'scroll_depth'];
if (!in_array($kind, KINDS, true)) {
    respond(['ok' => false, 'error' => 'unknown_kind'], 422);
}

$label  = (string) (body_field('label', 60) ?? '');
$path   = (string) (body_field('path', 120) ?? '/');
$visitor = anon_id((string) (body_field('visitor', 64) ?? ''));
$vh     = daily_visitor_hash(salt());
$day    = gmdate('Y-m-d');
$ts     = gmdate('c');

rate_limit('collect:' . $vh, 40, 300);

$pdo = db();

try {
    if ($kind === 'pageview') {
        $ref = (string) (body_field('referrer', 200) ?? '');
        // keep referrer host only, never the full URL with query string
        $host = $ref !== '' ? (parse_url($ref, PHP_URL_HOST) ?: '') : '';
        $stmt = $pdo->prepare(
            'INSERT INTO visitors (day, visitor, referrer, path, hits) VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(day, visitor, path) DO UPDATE SET hits = hits + 1'
        );
        $stmt->execute([$day, $vh, $host, $path]);
    }

    $stmt = $pdo->prepare(
        'INSERT INTO events (kind, label, path, visitor, day, ts) VALUES (?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([$kind, $label, $path, $vh, $day, $ts]);
} catch (Throwable $e) {
    respond(['ok' => false, 'error' => 'write_failed'], 500);
}

respond(['ok' => true, 'visitor' => $visitor]);
