import { expectTypeOf, test } from "vitest";
import type {
  AssetSnapshotV1, SnapshotV1, CaseDslV1, JobManifestV1,
  ClaimRequest, ClaimDTO, ExecutionSnapshotV1, CompiledAssetBundle,
  ExecutionEventV1, BundleManifestV1, OfflineResultV1, PlatformPaths,
} from "../src/index.js";

test("generated public contracts retain names and job discrimination", () => {
  expectTypeOf<SnapshotV1>().toEqualTypeOf<AssetSnapshotV1>();
  expectTypeOf<Extract<JobManifestV1, {kind:"TEST"}>>().toHaveProperty("caseExecutionId");
  expectTypeOf<Extract<JobManifestV1, {kind:"VALIDATE"}>>().toHaveProperty("revision");
  expectTypeOf<Extract<JobManifestV1, {kind:"CLEANUP"}>>().toHaveProperty("maintenanceId");
  expectTypeOf<CaseDslV1>().toHaveProperty("steps");
  expectTypeOf<ClaimRequest>().toHaveProperty("clientRequestId");
  expectTypeOf<ClaimDTO>().toHaveProperty("fencingToken");
  expectTypeOf<ExecutionSnapshotV1>().toHaveProperty("secretVersions");
  expectTypeOf<CompiledAssetBundle>().toHaveProperty("sourceHash");
  expectTypeOf<ExecutionEventV1>().toHaveProperty("sequence");
  expectTypeOf<BundleManifestV1>().toHaveProperty("files");
  expectTypeOf<OfflineResultV1>().toHaveProperty("localRunId");
  expectTypeOf<PlatformPaths>().toHaveProperty("/internal/v1/runtimes/claim");
});
