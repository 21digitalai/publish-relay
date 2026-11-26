export class PostValidationError extends Error {}
export class PostNotFoundError extends Error {}

export class PostRevisionConflictError extends PostValidationError {}
