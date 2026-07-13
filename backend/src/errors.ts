export class DatabaseError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class VertexError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'VertexError';
  }
}
