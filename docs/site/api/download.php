<?php
/**
 * POST /api/download.php
 * Body: { artifact, visitor? }
 *
 * Records intent to install. artifact must be in the allowlist.
 * The file itself is still served by Apache — this only counts.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

require_post();

$artifact = body_field('artifact', 40);
const ARTIFACTS = ['install.sh', 'memphis-v5-source', 'release-notes'];
if ($artifact === null || !in_array($artifact, ARTIFACTS, true)) {
    respond(['ok' => false, 'error' => 'unknown_artifact'], 422);
}

$vh  = daily_visitor_hash(salt());
$day = gmdate('Y-m-d');
rate_limit('dl:' . $vh, 15, 300);

$pdo = db();
$stmt = $pdo->prepare('INSERT INTO downloads (artifact, visitor, day, ts) VALUES (?, ?, ?, ?)');
$stmt->execute([$artifact, $vh, $day, gmdate('c')]);

$stmt = $pdo->prepare('INSERT INTO events (kind, label, path, visitor, day, ts) VALUES (?, ?, ?, ?, ?, ?)');
$stmt->execute(['download', $artifact, '/', $vh, $day, gmdate('c')]);

respond(['ok' => true]);
