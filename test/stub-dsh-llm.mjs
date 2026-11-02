export class LlmAdapter { constructor() {} }
export class LlmError extends Error { constructor(message, code) { super(message); this.failure = { message, code }; } }
export const ReasoningEffortId = (id) => id;
export const resolveRetryPolicy = (policy) => policy;
