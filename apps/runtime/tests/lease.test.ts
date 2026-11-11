import assert from "node:assert/strict";
import { test } from "node:test";
import { leaseDeadline } from "../src/lease.js";

const grant = {
  serverTime: "2026-11-11T12:00:00.000000Z",
  leaseExpiresAt: "2026-11-11T12:01:00.000000Z",
  leaseDurationMs: 60000,
};

test("lease deadline uses elapsed monotonic roundtrip, independent of client wall clock", () => {
  const original = Date.now;
  try {
    for (const wall of [0, 9999999999999]) {
      Date.now = () => wall;
      assert.equal(leaseDeadline(grant, 100, 1100), 59100);
      assert.equal(leaseDeadline(grant, 100, 20100), 59100);
    }
  } finally {
    Date.now = original;
  }
});

test("late or invalid grants cannot authorize local work", () => {
  assert.throws(() => leaseDeadline(grant, 100, 60100), /LEASE_BUDGET_EXHAUSTED/);
  assert.throws(() => leaseDeadline({ ...grant, leaseDurationMs: 120000 }, 0, 1), /INVALID_LEASE/);
  assert.throws(() => leaseDeadline(grant, 100, 90), /INVALID_LEASE/);
});
