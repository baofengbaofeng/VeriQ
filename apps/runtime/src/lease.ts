/** Conservative local stop deadline. Never compare server UTC with the device wall clock. */
export interface LeaseGrant {
  serverTime: string;
  leaseExpiresAt: string;
  leaseDurationMs: number;
}

export function leaseDeadline(
  grant: LeaseGrant,
  requestStarted: number,
  responseReceived: number,
): number {
  const duration = Date.parse(grant.leaseExpiresAt) - Date.parse(grant.serverTime);
  if (
    !Number.isFinite(duration) || duration <= 0 || duration > 60000 ||
    !Number.isSafeInteger(grant.leaseDurationMs) || grant.leaseDurationMs <= 0 ||
    grant.leaseDurationMs > 60000 || !Number.isFinite(requestStarted) ||
    !Number.isFinite(responseReceived) || requestStarted < 0 ||
    responseReceived < requestStarted
  ) throw new Error("INVALID_LEASE");
  // Starting at send time deducts the complete roundtrip, including delayed responses.
  // A one-second reserve allows the supervisor to stop before the server authorization ends.
  const deadline = requestStarted + Math.min(duration, grant.leaseDurationMs) - 1000;
  if (deadline <= responseReceived) throw new Error("LEASE_BUDGET_EXHAUSTED");
  return deadline;
}
