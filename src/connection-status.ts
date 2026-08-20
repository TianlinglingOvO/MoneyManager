export type ConnectionIssueCode =
  | "AUTH_EXPIRED"
  | "FORBIDDEN"
  | "OFFLINE"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_RESPONSE";

export interface ConnectionIssue {
  code: ConnectionIssueCode;
  message: string;
}

type Listener = () => void;

let currentIssue: ConnectionIssue | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function getConnectionIssue(): ConnectionIssue | null {
  return currentIssue;
}

export function subscribeConnectionIssue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportConnectionIssue(issue: ConnectionIssue): void {
  if (currentIssue?.code === issue.code && currentIssue.message === issue.message) return;
  currentIssue = issue;
  emit();
}

export function clearConnectionIssue(): void {
  if (!currentIssue) return;
  currentIssue = null;
  emit();
}

export function isConnectionIssueCode(code: string): code is ConnectionIssueCode {
  return ["AUTH_EXPIRED", "FORBIDDEN", "OFFLINE", "SERVICE_UNAVAILABLE", "INVALID_RESPONSE"].includes(code);
}
