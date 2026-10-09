<?php
/**
 * Retention enforcement. Run from cron:
 *   0 4 * * * curl -fsS https://memphis-v5.pl/api/cron-cleanup.php -H "X-Cron-Token: $TOKEN"
 *
 * The privacy policy promises 90-day retention for analytics. This makes
 * that promise executable rather than aspirational.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    respond(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

// Shared secret from the host environment; no default, see require_token().
require_token('HTTP_X_CRON_TOKEN');

$retentionDays = 90;
$cutoff        = gmdate('Y-m-d', time() - ($retentionDays * 86400));

$pdo = db();
$pdo->beginTransaction();
try {
    $deleted = [];
    foreach (['visitors', 'events', 'downloads'] as $table) {
        $stmt = $pdo->prepare("DELETE FROM {$table} WHERE day < ?");
        $stmt->execute([$cutoff]);
        $deleted[$table] = $stmt->rowCount();
    }
    // rate-limit buckets older than 2h
    $stmt = $pdo->prepare('DELETE FROM rate_limits WHERE window < ?');
    $stmt->execute([time() - 7200]);
    $deleted['rate_limits'] = $stmt->rowCount();

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respond(['ok' => false, 'error' => 'cleanup_failed'], 500);
}

// VACUUM must run outside a transaction. A failure here is cosmetic:
// the deletes already committed, so we report it rather than 500.
$vacuumed = true;
try {
    $pdo->exec('VACUUM');
} catch (Throwable $e) {
    $vacuumed = false;
}

respond([
    'ok'       => true,
    'cutoff'   => $cutoff,
    'deleted'  => $deleted,
    'vacuumed' => $vacuumed,
]);
