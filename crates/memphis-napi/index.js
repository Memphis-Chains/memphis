/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable no-undef */
/* eslint-disable preserve-caught-error */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(__filename);

function getBinaryName() {
  const { platform, arch } = process;
  const platformMap = { linux: 'linux', darwin: 'darwin', win32: 'win32' };
  const archMap = { x64: 'x64', arm64: 'arm64' };
  const suffix = platform === 'win32' ? '.dll' : '.node';
  return `${platformMap[platform]}-${archMap[arch]}${suffix}`;
}

const binaryPath = join(__dirname, getBinaryName());
let nativeModule;

try {
  nativeModule = require(binaryPath);
} catch (e) {
  throw new Error(`Failed to load native binary: ${e.message}. Platform: ${process.platform}-${process.arch}`, { cause: e });
}

export default nativeModule;
export const chainQuery = nativeModule.chainQuery;
export const chainAppend = nativeModule.chainAppend;
export const embedReset = nativeModule.embedReset;
export const embedStore = nativeModule.embedStore;
export const embedSearch = nativeModule.embedSearch;
export const chainValidate = nativeModule.chainValidate;
export const vaultDecrypt = nativeModule.vaultDecrypt;
export const vaultEncrypt = nativeModule.vaultEncrypt;
export const vaultInitJson = nativeModule.vaultInitJson;
export const embedSearchTuned = nativeModule.embedSearchTuned;
export const vaultInit = nativeModule.vaultInit;
export const vaultStore = nativeModule.vaultStore;
export const vaultRetrieve = nativeModule.vaultRetrieve;
export const vaultInitFull = nativeModule.vaultInitFull;
