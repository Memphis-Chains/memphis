export const ERROR_SUGGESTIONS = {
  missingEnv:
    'Copy .env.example to .env, fill in the required keys, then rerun `npm run -s cli -- doctor`.',
  missingOllama:
    'Install Ollama from https://ollama.com, start it with `ollama serve`, and pull the required model.',
  invalidApiKey:
    'Check the configured API key in .env, rotate it if needed, then rerun `npm run -s cli -- doctor`.',
  network:
    'Verify the endpoint URL, local network access, and that the target service is running before retrying.',
  permission: 'Check filesystem permissions for the current user and retry the command.',
} as const;
