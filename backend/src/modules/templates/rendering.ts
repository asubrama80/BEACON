import { ALLOWED_PLACEHOLDER_KEYS } from "./placeholders.js";

/** Matches any `{{...}}` span, capturing its raw inner content for classification. */
const PLACEHOLDER_SPAN_PATTERN = /\{\{([^}]*)\}\}/g;
/** A syntactically valid placeholder body: a bare identifier, optionally padded with whitespace. */
const VALID_PLACEHOLDER_BODY = /^[A-Za-z0-9_]+$/;
/** Other template-language syntax this module explicitly refuses to treat as inert text. */
const DANGEROUS_SYNTAX_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\$\{[^}]*\}/, label: "${...} expression syntax" },
  { pattern: /<%[\s\S]*?%>/, label: "<% %> template-code syntax" },
];

export interface TemplateContentValidation {
  valid: boolean;
  errors: string[];
  /** Distinct, allowlisted placeholder keys actually referenced — only meaningful when valid. */
  placeholders: string[];
}

/**
 * Validates that a piece of Template text (a body or subject) contains only inert data:
 * plain text plus zero or more `{{knownPlaceholder}}` tokens from the shared registry. Rejects
 * anything that looks like it might be interpreted as code by a templating/expression engine —
 * Template content must never become executable, even inertly-by-accident.
 */
export function validateTemplateContent(text: string): TemplateContentValidation {
  const errors: string[] = [];
  const placeholders = new Set<string>();

  for (const { pattern, label } of DANGEROUS_SYNTAX_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`Template content must not contain ${label}.`);
    }
  }

  for (const match of text.matchAll(PLACEHOLDER_SPAN_PATTERN)) {
    const raw = match[1] ?? "";
    const trimmed = raw.trim();
    if (!VALID_PLACEHOLDER_BODY.test(trimmed)) {
      errors.push(`Malformed placeholder syntax: "{{${raw}}}".`);
      continue;
    }
    if (!ALLOWED_PLACEHOLDER_KEYS.has(trimmed)) {
      errors.push(`Unknown placeholder: "{{${trimmed}}}".`);
      continue;
    }
    placeholders.add(trimmed);
  }

  return { valid: errors.length === 0, errors, placeholders: [...placeholders] };
}

export interface RenderInput {
  subject?: string | undefined;
  body: string;
  values: Record<string, string>;
}

export interface RenderResult {
  renderedSubject?: string;
  renderedBody: string;
  /** Placeholder keys present in the content that `values` didn't supply a value for. */
  unresolvedPlaceholders: string[];
}

/**
 * Deterministic, allowlisted plain-text substitution — never evaluates the content as code and
 * never queries a database itself. Reusable as-is by a future Alert module for real-recipient
 * rendering: pass real Contact field values instead of `samplePlaceholderValues()`. An
 * unresolved placeholder is left as its original `{{key}}` token in the output (never silently
 * dropped or replaced with something misleading) and is also reported explicitly in
 * `unresolvedPlaceholders`, so a caller can decide what "unresolved" should mean for its own
 * use case (e.g. a future Alert-send path blocking on any unresolved placeholder).
 */
export function renderTemplate(input: RenderInput): RenderResult {
  const unresolved = new Set<string>();

  function substitute(text: string): string {
    return text.replace(PLACEHOLDER_SPAN_PATTERN, (fullMatch, raw: string) => {
      const key = raw.trim();
      if (Object.prototype.hasOwnProperty.call(input.values, key)) {
        return input.values[key]!;
      }
      unresolved.add(key);
      return fullMatch;
    });
  }

  const renderedBody = substitute(input.body);
  const renderedSubject = input.subject !== undefined ? substitute(input.subject) : undefined;

  const result: RenderResult = { renderedBody, unresolvedPlaceholders: [...unresolved] };
  if (renderedSubject !== undefined) result.renderedSubject = renderedSubject;
  return result;
}
