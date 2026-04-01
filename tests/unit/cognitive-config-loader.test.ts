import { describe, expect, it } from 'vitest';

import { loadCognitiveConfig } from '../../src/cognitive/config-loader.js';


describe('loadCognitiveConfig', () => {
  describe('default values (no env vars)', () => {
    it('returns modelA defaults', () => {
      const config = loadCognitiveConfig({});

      // Model A defaults from config-loader.ts
      expect(config.modelA.autoCapture).toBe(true);
      expect(config.modelA.captureLevel).toBe('normal');
      expect(config.modelA.requireConfirmation).toBe(true);
    });

    it('returns modelB defaults', () => {
      const config = loadCognitiveConfig({});

      // Model B defaults from config-loader.ts
      expect(config.modelB.gitWatchEnabled).toBe(false);
      expect(config.modelB.fileWatchEnabled).toBe(false);
      expect(config.modelB.confidenceThreshold).toBe(0.45);
    });

    it('returns modelC defaults', () => {
      const config = loadCognitiveConfig({});

      // Model C defaults from config-loader.ts
      expect(config.modelC.patternMinOccurrences).toBe(3);
      expect(config.modelC.confidenceCap).toBe(0.85);
    });

    it('returns modelD defaults', () => {
      const config = loadCognitiveConfig({});

      // Model D defaults from config-loader.ts
      expect(config.modelD.consensusThreshold).toBe(0.6);
      expect(config.modelD.votingTimeout).toBe(30000);
    });

    it('returns modelE defaults', () => {
      const config = loadCognitiveConfig({});

      // Model E defaults from config-loader.ts
      expect(config.modelE.reflectionSchedule).toBe('both');
      expect(config.modelE.contradictionDetection).toBe(true);
      expect(config.modelE.blindSpotAnalysis).toBe(true);
    });

    it('returns complete CognitiveEngineConfig structure', () => {
      const config = loadCognitiveConfig({});

      expect(config).toHaveProperty('modelA');
      expect(config).toHaveProperty('modelB');
      expect(config).toHaveProperty('modelC');
      expect(config).toHaveProperty('modelD');
      expect(config).toHaveProperty('modelE');
    });
  });

  describe('env var overrides', () => {
    it('COGNITIVE_MODEL_A_AUTO_CAPTURE=true overrides autoCapture', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_A_AUTO_CAPTURE: 'true',
      });
      expect(config.modelA.autoCapture).toBe(true);
    });

    it('COGNITIVE_MODEL_B_GIT_WATCH_ENABLED=true overrides gitWatchEnabled', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_B_GIT_WATCH_ENABLED: 'true',
      });
      expect(config.modelB.gitWatchEnabled).toBe(true);
    });

    it('COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD=0.9 overrides confidenceThreshold', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD: '0.9',
      });
      expect(config.modelB.confidenceThreshold).toBe(0.9);
    });

    it('COGNITIVE_MODEL_C_PATTERN_MIN_OCCURRENCES=10 overrides patternMinOccurrences', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_C_PATTERN_MIN_OCCURRENCES: '10',
      });
      expect(config.modelC.patternMinOccurrences).toBe(10);
    });

    it('COGNITIVE_MODEL_E_REFLECTION_SCHEDULE=daily overrides reflectionSchedule', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_E_REFLECTION_SCHEDULE: 'daily',
      });
      expect(config.modelE.reflectionSchedule).toBe('daily');
    });

    it('COGNITIVE_MODEL_E_CONTRADICTION_DETECTION=false overrides contradictionDetection', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_E_CONTRADICTION_DETECTION: 'false',
      });
      expect(config.modelE.contradictionDetection).toBe(false);
    });
  });

  describe('boolean string parsing', () => {
    it('parses COGNITIVE_MODEL_A_AUTO_CAPTURE=true string', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_A_AUTO_CAPTURE: 'true',
      });
      expect(config.modelA.autoCapture).toBe(true);
    });

    it('parses COGNITIVE_MODEL_B_FILE_WATCH_ENABLED=false string', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_B_FILE_WATCH_ENABLED: 'false',
      });
      expect(config.modelB.fileWatchEnabled).toBe(false);
    });
  });

  describe('partial overrides', () => {
    it('partial override leaves other modelB fields at defaults', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD: '0.9',
      });
      expect(config.modelB.confidenceThreshold).toBe(0.9);
      expect(config.modelB.gitWatchEnabled).toBe(false); // still at default
      expect(config.modelB.fileWatchEnabled).toBe(false); // still at default
      expect(config.modelB.minConfidence).toBe(0.3); // still at default
    });

    it('partial override leaves other model fields at defaults', () => {
      const config = loadCognitiveConfig({
        COGNITIVE_MODEL_A_AUTO_CAPTURE: 'false',
      });
      expect(config.modelA.autoCapture).toBe(false);
      expect(config.modelA.captureLevel).toBe('normal'); // still at default
      expect(config.modelA.requireConfirmation).toBe(true); // still at default
      expect(config.modelB.gitWatchEnabled).toBe(false); // modelB unchanged
    });
  });
});
