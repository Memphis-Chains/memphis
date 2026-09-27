<?php
/**
 * GET /api/health.php
 * Backend liveness. Deliberately exposes nothing about the host.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

header('Cache-Control: no-store');
try {
    $pdo = db();
    $pdo->query('SELECT 1');
    respond([
        'ok'    => true,
        'db'    => 'writable',
        'php'   => PHP_VERSION,
        'utc'   => gmdate('c'),
    ]);
} catch (Throwable $e) {
    respond(['ok' => false, 'error' => 'db_unavailable'], 500);
}
