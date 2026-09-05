export interface ParsedOmegaLog {
  rawLogContent: string;
  importedDocumentIds: string[];
  errors: string[];
}

export class OmegaImportLogParser {
  public parse(logContent: string | null): ParsedOmegaLog {
    const result: ParsedOmegaLog = {
      rawLogContent: logContent || '',
      importedDocumentIds: [],
      errors: []
    };

    if (!logContent) {
      result.errors.push('LOG_MISSING');
      return result;
    }

    const lines = logContent.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes('SUCCESS') && line.includes('Document:')) {
        // e.g. "Document: DOC-123 SUCCESS"
        const match = line.match(/Document:\s+(\S+)\s+SUCCESS/);
        if (match && match[1]) {
          result.importedDocumentIds.push(match[1]);
        }
      } else if (line.includes('ERROR') || line.includes('Chyba')) {
        result.errors.push(line);
      }
    }

    return result;
  }
}
