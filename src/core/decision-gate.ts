export type DecisionSignal = {
  detected: boolean;
  title?: string;
  choice?: string;
  confidence: number;
  reason: string;
};

const DECISION_VERBS = ['wybieram', 'decyduję', 'postanawiam', 'select', 'choose', 'decide'];

export function inferDecisionFromText(input: string): DecisionSignal {
  const raw = input.trim();
  if (raw.length === 0) return { detected: false, confidence: 0, reason: 'empty-input' };

  const lc = raw.toLowerCase();
  const hasVerb = DECISION_VERBS.some((v) => lc.includes(v));
  const split = raw.split(/[:-]/).map((s) => s.trim()).filter(Boolean);
  const title = split[0];
  const choice = split[1];

  if (hasVerb || (title && choice)) {
    return {
      detected: true,
      title,
      choice,
      confidence: hasVerb && choice ? 0.9 : 0.7,
      reason: hasVerb ? 'decision-verb-detected' : 'title-choice-pattern',
    };
  }

  return { detected: false, confidence: 0.2, reason: 'no-decision-pattern' };
}
