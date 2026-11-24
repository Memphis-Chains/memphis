<?php
declare(strict_types=1);

// The web host reaches only the public chat listener through a private Unix socket.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function failure(int $status, string $error): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    failure(405, 'method_not_allowed');
}
if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') {
    failure(415, 'invalid_input');
}
$limit = 48 * 1024;
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) {
    failure(413, 'invalid_input');
}
$body = file_get_contents('php://input', false, null, 0, $limit + 1);
if ($body === false || strlen($body) > $limit) {
    failure(413, 'invalid_input');
}
if (!extension_loaded('curl')) {
    failure(503, 'backend_unavailable');
}
$ip = filter_var($_SERVER['REMOTE_ADDR'] ?? '', FILTER_VALIDATE_IP);
$request = curl_init('http://localhost/chat');
curl_setopt_array($request, [
    CURLOPT_UNIX_SOCKET_PATH => dirname(__DIR__, 3) . '/.memphis-chat/run/gateway.sock',
    CURLOPT_PROXY => '',
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Expect:', 'X-Real-IP: ' . ($ip ?: '127.0.0.1')],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 2,
    CURLOPT_TIMEOUT => 125,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADERFUNCTION => static function ($handle, string $line): int {
        if (preg_match('/^Retry-After:\s*(\d{1,4})\s*$/i', $line, $m)) {
            header('Retry-After: ' . $m[1]);
        }
        return strlen($line);
    },
]);
$reply = curl_exec($request);
$status = curl_getinfo($request, CURLINFO_RESPONSE_CODE);
if ($reply === false || !in_array($status, [200, 400, 413, 415, 422, 429, 502, 503], true)) {
    failure(503, 'backend_unavailable');
}
http_response_code($status);
echo $reply;
