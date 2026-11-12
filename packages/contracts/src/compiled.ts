import type {
  AssertionV1,
  StepV1,
  CaseDslV1,
  JsonValue,
} from "./types.generated.js";
export interface CompiledAssertion {
  assertion: Exclude<
    AssertionV1,
    {
      type: "template";
    }
  >;
  sourcePath: string;
  /** Original DSL identifier for report display; absent in historical compiled plans. */
  sourceId?: string;
  parameters: Record<string, JsonValue>[];
}
export interface CompiledStep {
  step: StepV1;
  sourcePath: string;
  /** Original DSL identifier for report display; absent in historical compiled plans. */
  sourceId?: string;
  before: CompiledAssertion[];
  responseAssertions: CompiledAssertion[];
  after: CompiledAssertion[];
  children?: CompiledStep[];
}
export interface CompiledCase {
  caseVersionId: string;
  document: CaseDslV1;
  steps: CompiledStep[];
  persistenceCheckpointStepId?: string;
}
