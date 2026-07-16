import type { MemoryCandidate } from '@deeprecall/types';
import type { PolicyContext, PolicyRule, RuleResult } from '../types';

/** Patterns that indicate PII or sensitive data. */
const DEFAULT_PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // SSN: 123-45-6789 or 123 45 6789 (separators required to reduce false positives)
  {
    name: 'SSN',
    pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/,
  },
  // Credit card numbers (Visa, Mastercard, Amex, Discover — 13-19 digits)
  {
    name: 'credit_card',
    pattern:
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/,
  },
  // API keys / tokens (long hex or base64 strings with common prefixes)
  {
    name: 'api_key',
    pattern:
      /\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|xox[bpra]-[a-zA-Z0-9-]{10,})\b/,
  },
  // Generic long secret-looking strings (40+ hex chars often indicate tokens/hashes)
  {
    name: 'hex_secret',
    pattern: /\b[a-f0-9]{40,}\b/i,
  },
  // Passwords in common formats: password=..., pwd:..., passwd ...
  {
    name: 'password_pattern',
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
  },
  // Private keys (PEM format headers)
  {
    name: 'private_key',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  },
];

/** Compiles additional PII patterns from product overrides. */
function compileAdditionalPatterns(patterns: string[]): Array<{ name: string; pattern: RegExp }> {
  return patterns
    .map((p, i) => {
      try {
        return { name: `custom_pii_${i}`, pattern: new RegExp(p) };
      } catch {
        return null;
      }
    })
    .filter((p): p is { name: string; pattern: RegExp } => p !== null);
}

export function createPiiDetectionRule(additionalPatterns?: string[]): PolicyRule {
  const allPatterns = [
    ...DEFAULT_PII_PATTERNS,
    ...compileAdditionalPatterns(additionalPatterns ?? []),
  ];

  return {
    name: 'pii_detection',
    description:
      'Blocks memories containing PII (SSNs, credit cards, API keys, passwords, private keys)',
    evaluate(candidate: MemoryCandidate, _context: PolicyContext): RuleResult {
      const textToCheck = [
        candidate.content,
        candidate.episode,
        candidate.subject,
        candidate.object,
      ]
        .filter(Boolean)
        .join(' ');

      for (const { name, pattern } of allPatterns) {
        if (pattern.test(textToCheck)) {
          return {
            passed: false,
            reason: `PII detected: ${name} pattern matched`,
          };
        }
      }

      return { passed: true };
    },
  };
}
