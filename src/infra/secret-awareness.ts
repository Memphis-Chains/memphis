export type ManagedSecret = {
  key: 'MEMPHIS_API_TOKEN' | 'MEMPHIS_VAULT_PEPPER';
  value: string;
  preview: string;
  purpose: string;
  rotationWarning: string;
};

export type SecretAwareness = {
  envPath: string;
  agentProfilePath?: string;
  secrets: ManagedSecret[];
  note: string;
};

function previewSecret(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(Math.max(value.length, 4));
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function buildSecretAwareness(input: {
  envPath: string;
  agentProfilePath?: string;
  apiToken: string;
  vaultPepper: string;
}): SecretAwareness {
  return {
    envPath: input.envPath,
    agentProfilePath: input.agentProfilePath,
    secrets: [
      {
        key: 'MEMPHIS_API_TOKEN',
        value: input.apiToken,
        preview: previewSecret(input.apiToken),
        purpose: 'Protects authenticated HTTP routes and external clients must send it as a Bearer token.',
        rotationWarning: 'Rotating it invalidates existing API clients until they are updated.',
      },
      {
        key: 'MEMPHIS_VAULT_PEPPER',
        value: input.vaultPepper,
        preview: previewSecret(input.vaultPepper),
        purpose: 'Anchors the local vault bridge and is required to decrypt existing vault state.',
        rotationWarning: 'Changing it breaks access to previously encrypted vault data.',
      },
    ],
    note: 'Store the .env file securely. Memphis needs these values again after restart or migration.',
  };
}

export function renderSecretAwarenessLines(secretAwareness: SecretAwareness): string[] {
  const lines = [
    'Secret awareness:',
    `  .env: ${secretAwareness.envPath}`,
  ];

  if (secretAwareness.agentProfilePath) {
    lines.push(`  Agent profile: ${secretAwareness.agentProfilePath}`);
  }

  for (const secret of secretAwareness.secrets) {
    lines.push(`  ${secret.key}: ${secret.preview}`);
    lines.push(`    Purpose: ${secret.purpose}`);
    lines.push(`    Rotation: ${secret.rotationWarning}`);
  }

  lines.push(`  Note: ${secretAwareness.note}`);
  return lines;
}

export function renderSecretAwarenessText(secretAwareness: SecretAwareness): string {
  return renderSecretAwarenessLines(secretAwareness).join('\n');
}
