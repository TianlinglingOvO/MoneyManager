export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "BAD_REQUEST"
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "未找到对应记录") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class ProposalRevisionConflictError extends AppError {
  constructor(message = "待确认内容已经更新，请重新查看后再操作") {
    super(message, 409, "PROPOSAL_REVISION_CONFLICT");
  }
}
