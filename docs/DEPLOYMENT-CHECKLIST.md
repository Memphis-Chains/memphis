# Memphis Deployment Checklist

## 1) Pre-deployment checks

- [ ] `npm ci` completes successfully.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] Security scan reviewed (`npm audit`, dependency reports).
- [ ] Release notes / `CHANGELOG.md` updated for this version.
- [ ] Container image built locally (`docker build -t memphis:<tag> .`).
- [ ] Health endpoint validated locally (`/health`).

## 2) Environment setup

- [ ] Runtime env file prepared (`NODE_ENV`, `PORT`, provider URLs).
- [ ] Secrets provisioned (API keys, tokens) via secret manager/K8s Secret.
- [ ] Persistent storage prepared for `~/.memphis` and app data.
- [ ] Network ingress/DNS configured for Memphis API hostname.
- [ ] Observability endpoints connected (logs, metrics, alerts).

## 3) Configuration validation

- [ ] ConfigMap values match target environment (prod/staging).
- [ ] `DEFAULT_PROVIDER` and provider credentials are consistent.
- [ ] `DATABASE_URL` points to persistent path.
- [ ] Resource limits/requests are set and reviewed.
- [ ] Liveness/readiness probes match `/health` behavior.

## 4) Backup procedures

- [ ] Snapshot current DB and `~/.memphis` data before deployment.
- [ ] Export previous container image/tag reference.
- [ ] Verify backup restore command/path with a quick dry run.
- [ ] Store backup metadata: timestamp, version, operator.

## 5) Rollback plan

- [ ] Previous stable image tag identified and documented.
- [ ] `kubectl rollout undo deployment/memphis` verified.
- [ ] Manual rollback command for Docker Compose prepared.
- [ ] Rollback trigger criteria agreed (e.g., error rate, failed health checks).
- [ ] On-call owner and communication channel confirmed.

## 6) Post-deployment verification

- [ ] Deployment rollout complete (`kubectl rollout status`).
- [ ] `/health` returns healthy from cluster and external endpoint.
- [ ] Core smoke tests pass (CLI + API).
- [ ] Logs show no startup/runtime critical errors.
- [ ] Provider connectivity verified (shared/decentralized/local fallback).
- [ ] Persisted data read/write verified.
- [ ] Release announcement sent with version + rollback reference.
