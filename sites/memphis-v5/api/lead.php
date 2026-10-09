<?php
/**
 * POST /api/lead.php
 * Body: { email, consent, kind?, source? }
 *
 * Single opt-in with explicit consent. We never send mail from here
 * (the panel's MAIL_MAILER=log means confirmation mails never arrive),
 * so the response tells the truth about what happens next.
 */
declare(strict_types=1);
require __DIR__ . '/_boot.php';

require_post();

$email   = body_field('email', 254);
$consent = body_field('consent', 5);
$kind    = (string) (body_field('kind', 24) ?? 'newsletter');
$source  = (string) (body_field('source', 40) ?? 'site');

if ($email === null || !valid_email($email)) {
    respond(['ok' => false, 'error' => 'invalid_email'], 422);
}
if ($consent !== 'true') {
    respond(['ok' => false, 'error' => 'consent_required'], 422);
}
if (!in_array($kind, ['newsletter', 'consultation', 'contact'], true)) {
    $kind = 'newsletter';
}

$vh = daily_visitor_hash(salt());
rate_limit('lead:' . $vh, 5, 600);

$pdo   = db();
$email = mb_strtolower($email);

$stmt = $pdo->prepare('SELECT id, confirmed FROM leads WHERE email = ?');
$stmt->execute([$email]);
$existing = $stmt->fetch();

if ($existing !== false) {
    respond([
        'ok'       => true,
        'status'   => 'already_subscribed',
        'message'  => 'Ten adres jest już zapisany. Nie wysyłamy nic więcej.',
    ]);
}

try {
    $stmt = $pdo->prepare(
        'INSERT INTO leads (email, source, kind, consent, confirmed, created_at)
         VALUES (?, ?, ?, 1, 0, ?)'
    );
    $stmt->execute([$email, $source, $kind, gmdate('c')]);
} catch (PDOException $e) {
    if (str_contains($e->getMessage(), 'UNIQUE')) {
        respond(['ok' => true, 'status' => 'already_subscribed',
                 'message' => 'Ten adres jest już zapisany.']);
    }
    respond(['ok' => false, 'error' => 'write_failed'], 500);
}

$stmt = $pdo->prepare('INSERT INTO events (kind, label, path, visitor, day, ts) VALUES (?, ?, ?, ?, ?, ?)');
$stmt->execute(['newsletter', $kind, '/newsletter', $vh, gmdate('Y-m-d'), gmdate('c')]);

respond([
    'ok'      => true,
    'status'  => 'subscribed',
    'message' => 'Zapisane. Potwierdzenie mailem dojdzie po uruchomieniu SMTP — na razie zapis jest pewny.',
]);
