/**
 * 线上真实业务夹具与 Mac source suite 共用同一冻结引擎、HTTP 控制夹具及上传摘要核验，Linux 仍验证内核全部后代范围；本
 * 入口保留原有失败、重试成功、丢失激活与受限 Trace 回归，不依赖任何付费模型或
 * 外部平台。
 */
import { test } from "node:test";
import { onlineBusiness } from "./fixtures/business-engine.ts";
test(
    "actual approved generated TS runs with fresh browser/fixture/workdir and real restricted traces",
    { timeout: 180000 },
    async () => {
        await onlineBusiness();
    },
);
