# Phase8 external-host transport proof (operator pack)

## Purpose
Prepare publication-grade evidence beyond localhost relay simulation.

## Generate template
```bash
npm run -s ops:phase8-external-proof-template -- /tmp/mv4-phase8-external-host-proof.json node-a.example.net node-b.example.net
```

## Validate proof artifact
```bash
npm run -s ops:phase8-external-proof-validate -- /tmp/mv4-phase8-external-host-proof.json
```

## Required semantics
- `kind` must be `phase8-external-host-transport-proof`
- `ok` must be `true`
- `nodeAHost` and `nodeBHost` must differ and cannot be localhost
- `payloadHash`, `nodeAHash`, `nodeBHash` must be sha256 hex and all equal

## Note
Template is intentionally a prep helper. For release evidence, replace values with real captures from two external hosts.
