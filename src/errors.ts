export type ErrorCode =
  | 'PARSE_UNCLOSED_VALUE'
  | 'PARSE_DANGLING_ESCAPE'
  | 'PARSE_EMPTY_TREE'
  | 'PARSE_MISSING_PROP_NAME'
  | 'PARSE_TRAILING_GARBAGE'
  | 'PARSE_DUPLICATE_PROP'
  | 'PARSE_INVALID_IDENT'
  | 'PARSE_EXPECTED'
  | 'LIMIT_TEXT_LENGTH'
  | 'LIMIT_NODE_COUNT'
  | 'LIMIT_DEPTH'
  | 'NOT_FOUND'
  | 'MUST_CHOOSE_BRANCH'
  | 'NO_CHILD'
  | 'NO_PARENT'
  | 'VALIDATION';

export class SgfError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public pos?: number,
    public line?: number,
    public col?: number
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, pos: this.pos, line: this.line, col: this.col };
  }
}
