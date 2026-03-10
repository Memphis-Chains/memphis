export type Decision = {
  question?: string;
  choice?: string;
  reasoning?: string;
  hash?: string;
  timestamp?: string;
  chainRef?: { chain?: string; index?: number };
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export class DecisionValidator {
  validate(decision: Decision): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!decision.question || decision.question.trim().length === 0) errors.push('Question is required');
    if (!decision.choice || decision.choice.trim().length === 0) errors.push('Choice is required');
    if (!decision.reasoning || decision.reasoning.trim().length < 10) warnings.push('Reasoning should be at least 10 characters');
    if (!decision.hash || !/^[a-f0-9]{64}$/.test(decision.hash)) errors.push('Invalid decision hash (expected SHA-256)');

    if (decision.chainRef && (!decision.chainRef.chain || decision.chainRef.index === undefined)) {
      errors.push('Invalid chain reference');
    }

    if (decision.timestamp) {
      const date = new Date(decision.timestamp);
      if (Number.isNaN(date.getTime())) errors.push('Invalid timestamp');
      if (date > new Date()) warnings.push('Timestamp is in the future');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  validateForChain(decision: Decision): boolean {
    const result = this.validate(decision);
    if (!result.valid) throw new Error(`Invalid decision: ${result.errors.join(', ')}`);
    return true;
  }
}
