export type Severity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  code: string;
  field: string;
  severity: Severity;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export const createResult = (): ValidationResult => ({
  valid: true,
  errors: [],
  warnings: [],
});

export const addError = (result: ValidationResult, code: string, field: string, message: string) => {
  result.valid = false;
  result.errors.push({ code, field, severity: 'ERROR', message });
};

export const addWarning = (result: ValidationResult, code: string, field: string, message: string) => {
  result.warnings.push({ code, field, severity: 'WARNING', message });
};

export const mergeResults = (target: ValidationResult, source: ValidationResult, fieldPrefix: string = '') => {
  if (!source.valid) target.valid = false;
  
  const prefix = fieldPrefix ? `${fieldPrefix}.` : '';
  
  for (const error of source.errors) {
    target.errors.push({ ...error, field: `${prefix}${error.field}` });
  }
  for (const warning of source.warnings) {
    target.warnings.push({ ...warning, field: `${prefix}${warning.field}` });
  }
};
