"""通过匿名就绪路由验证三种对象存储策略，以真实 SDK 的 Stubber 隔离网络并记录调用与资源关闭。

Tornado、专用 MySQL 和安装库存继续走生产检查。SDK 使用合成配置、明确的假凭据和拒绝发送的传输边界。
"""

import asyncio
from collections import abc
import contextlib
import copy
import dataclasses
import functools
import hashlib
import io
import logging
import os
import pathlib
import threading
import time
from typing import TYPE_CHECKING, Literal, Never, Unpack
from unittest import mock

import boto3
from boto3 import session
from botocore import config as sdk_config
from botocore import exceptions, httpsession
from botocore import model as sdk_model
from botocore import response as sdk_response
from botocore import stub
import pytest

from veriq_server import readiness

from apps.srv.tests.operations import readiness_support

# 显式绑定两项公共夹具，让 pytest 在本模块发现同一守卫和启动器并正常解析它们的依赖关系。
create_readiness_server = readiness_support.create_readiness_server
site = readiness_support.site

if TYPE_CHECKING:
    import mypy_boto3_s3


_ENDPOINT = "https://readiness.invalid"
_BUCKET = "veriq-readiness-probe-bucket"
_KEY = "synthetic/v02/readiness-object"
_REGION = "us-west-2"
_ACCESS = "FAKE-V02-READINESS-ACCESS"
_SECRET = "FAKE-V02-READINESS-SECRET"
_SERVICE_MARKER = "synthetic-v02-s3-service-error"
_READ_MARKER = "https://synthetic-v02-s3-read-error.invalid"
_PRIVATE = (
    _ENDPOINT,
    "readiness.invalid",
    _BUCKET,
    _KEY,
    _ACCESS,
    _SECRET,
    _SERVICE_MARKER,
    _READ_MARKER,
    "synthetic-v02-s3-read-error.invalid",
    "Unable to locate credentials",
)
_OBJECT_PARAMS = {"Bucket": _BUCKET, "Key": _KEY}
_EVENT = "provide-client-params.s3"
_OBSERVER = "veriq-readiness-s3-attempts"
_LOGGER = logging.getLogger(__name__)


def _unexpected_sdk_call(*args: object, **kwargs: object) -> Never:
    """工厂未获用例授权或 SDK 触及底层发送时立刻失败，避免替身失效后回退到网络或默认凭据会话。"""
    # 拒绝边界不读取请求或工厂参数，调用代理记录尝试后直接报告固定错误，避免诊断展开请求对象。
    del args, kwargs
    raise AssertionError("Unexpected S3 factory or transport call")


@dataclasses.dataclass
class _S3Probe:
    """在实际客户端上安装调用账本、Stubber 与关闭代理，使成功和降级都能核对完整的 SDK 活动。"""

    patches: pytest.MonkeyPatch
    resources: contextlib.ExitStack
    factory: mock.Mock
    transport: mock.Mock
    close: mock.Mock = dataclasses.field(default_factory=mock.Mock)
    operations: list[tuple[str, dict[str, object]]] = dataclasses.field(default_factory=list)
    stubber: stub.Stubber | None = None

    def open_client(
        self,
        service: Literal["s3"],
        *,
        endpoint_url: str,
        region_name: str,
        config: sdk_config.Config,
        queue: abc.Callable[[stub.Stubber], None] | None = None,
    ) -> "mypy_boto3_s3.S3Client":
        """重用工厂收到的区域和超时创建隔离客户端，在返回之前装好公开观察者、响应队列及真实关闭代理。"""
        assert self.stubber is None
        assert (service, endpoint_url, region_name) == ("s3", _ENDPOINT, _REGION)
        # SDK 初始化会就地补齐重试模式；复制工厂配置保留原始入参用于随后断言，同时禁用代理。
        isolated_config = copy.deepcopy(config).merge(sdk_config.Config(proxies={}))
        client = session.Session(profile_name="default").client(
            service,
            endpoint_url=endpoint_url,
            region_name=region_name,
            config=isolated_config,
            aws_access_key_id=_ACCESS,
            aws_secret_access_key=_SECRET,
        )

        # 保留真实关闭并先记录生产调用，夹具兜底只在零次关闭时执行，不能替遗漏清理的业务代码补绿。
        self.close.side_effect = client.close
        self.patches.setattr(client, "close", self.close)
        self.resources.callback(self._close_if_needed)
        client.meta.events.register_first(_EVENT, self._record_operation, unique_id=_OBSERVER)
        self.resources.callback(client.meta.events.unregister, _EVENT, unique_id=_OBSERVER)
        self.stubber = self.resources.enter_context(stub.Stubber(client))
        if queue is not None:
            queue(self.stubber)
        return client

    def _close_if_needed(self) -> None:
        """如果断言或初始化提前失败且客户端未由调用方关闭，退出夹具时仍调用真实关闭回收本地连接池。"""
        if not self.close.call_count:
            self.close()

    def _record_operation(
        self, *, params: abc.Mapping[str, object], model: sdk_model.OperationModel, **kwargs: object
    ) -> None:
        """在 Stubber 的参数验证前复制操作参数，即使后续立即拒绝额外操作也保留尝试且不改变 SDK 参数。"""
        # 事件可能附带上下文和事件名，账本只复制真实操作参数，忽略附加信息以免影响后续替身匹配。
        del kwargs
        self.operations.append((model.name, dict(params)))

    def assert_factory_call(self) -> None:
        """核对工厂收到的位置参数与严格的关键字集合，并验证生产传入的半秒超时和单次尝试预算。"""
        self.factory.assert_called_once()
        args, kwargs = self.factory.call_args
        assert args == ("s3",)
        assert set(kwargs) == {"endpoint_url", "region_name", "config"}
        assert kwargs["endpoint_url"] == _ENDPOINT
        assert kwargs["region_name"] == _REGION
        config = kwargs["config"]
        assert isinstance(config, sdk_config.Config)
        options: dict[str, object] = vars(config)
        assert options["connect_timeout"] == options["read_timeout"] == 0.5
        assert options["retries"] == {"total_max_attempts": 1}

    def assert_operation(self, name: str, params: dict[str, str]) -> None:
        """确认唯一工厂调用仅消耗一个精确 SDK 请求，生产关闭恰好一次，且 SDK 从未尝试将请求送上网络。"""
        self.assert_factory_call()
        assert self.operations == [(name, params)]
        assert self.stubber is not None
        self.stubber.assert_no_pending_responses()
        self.close.assert_called_once_with()
        self.transport.assert_not_called()

    def assert_no_client_activity(self) -> None:
        """确认尚未构造 SDK 客户端，没有操作、关闭或运输记录；工厂调用由不同策略的用例独立断言。"""
        assert self.stubber is None
        assert not self.operations
        self.close.assert_not_called()
        self.transport.assert_not_called()


@pytest.fixture(name="s3_probe")
def _s3_probe(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> abc.Iterator[_S3Probe]:
    """在应用和客户端构造前拦住工厂及 SDK 运输，退出时须先回收应用中的工作再恢复隔离配置。"""
    config = tmp_path / "aws-config"
    credentials = tmp_path / "aws-credentials"
    config.write_text("[default]\n", encoding="utf-8")
    credentials.write_text("", encoding="utf-8")
    with monkeypatch.context() as patches, contextlib.ExitStack() as resources:
        transport = mock.Mock(side_effect=_unexpected_sdk_call)
        factory = mock.Mock(side_effect=_unexpected_sdk_call)
        patches.setattr(httpsession.URLLib3Session, "send", transport)
        patches.setattr(boto3, "client", factory)
        # 清除继承的 SDK 配置选择，合成配置仅含默认 profile，客户端始终传入显式假凭据。
        for name in tuple(os.environ):
            if name.startswith("AWS_"):
                patches.delenv(name)
        patches.setenv("AWS_CONFIG_FILE", str(config))
        patches.setenv("AWS_SHARED_CREDENTIALS_FILE", str(credentials))
        patches.setenv("AWS_EC2_METADATA_DISABLED", "true")
        yield _S3Probe(patches, resources, factory, transport)


class _TrackedStream(io.BytesIO):
    """在真实 StreamingBody 下记录底层读长及关闭，也能模拟 SDK 读取超时而不构造任何实际连接。"""

    def __init__(self, payload: bytes, *, fail_read: bool = False) -> None:
        super().__init__(payload)
        self.read_sizes: list[int | None] = []
        self.close_count = 0
        self.fail_read = fail_read

    def read(self, size: int | None = -1, /) -> bytes:
        """逐次记下实际读取上限；指定超时时从底层流抛出 SDK 错误，成功路径仍返回真实内存字节。"""
        self.read_sizes.append(size)
        if self.fail_read:
            raise exceptions.ReadTimeoutError(endpoint_url=_READ_MARKER)
        return super().read(size)

    def close(self) -> None:
        """统计底层关闭次数后释放内存流，测试通过 StreamingBody 的真实委派观察读完和异常收尾。"""
        self.close_count += 1
        super().close()


@contextlib.contextmanager
def _tracked_body(stream: _TrackedStream, length: int) -> abc.Iterator[sdk_response.StreamingBody]:
    """保留实际流包装器的读取语义；只有生产未关闭底层流时才由夹具兜底，以便断言捕获遗漏。"""
    body = sdk_response.StreamingBody(stream, length)
    try:
        yield body
    finally:
        if not stream.closed:
            body.close()


def _s3_settings(
    **options: Unpack[readiness_support.ReadinessStorageOptions],
) -> readiness_support.ReadinessStorageOptions:
    """提供非空合成桶、惰性端点和显式区域；未覆盖的策略选项仍由生产 Settings 构造时填充。"""
    return {
        "artifact_backend": "S3",
        "artifact_s3_bucket": _BUCKET,
        "artifact_s3_endpoint": _ENDPOINT,
        "artifact_s3_region": _REGION,
        **options,
    }


def _read_settings(digest_source: bytes) -> readiness_support.ReadinessStorageOptions:
    """固定配置长度为五字节，摘要由用例指定的独立字节样本生成，便于让长度和散列故障各自单独生效。"""
    return _s3_settings(
        readiness_s3_strategy="read-object",
        readiness_s3_object_key=_KEY,
        readiness_s3_object_sha256=hashlib.sha256(digest_source).hexdigest(),
        readiness_s3_object_size=5,
    )


def _queue_body(stubber: stub.Stubber, body: sdk_response.StreamingBody, length: int) -> None:
    """队列元数据跟随真实替身字节而非期望长度，短流和长流都由应用自己的长度检查判为就绪降级。"""
    stubber.add_response(
        "get_object", {"Body": body, "ContentLength": length}, expected_params=_OBJECT_PARAMS
    )


async def test_default_disabled_s3_creates_no_sdk_client(
    readiness_server: readiness_support.ReadinessServer, s3_probe: _S3Probe
) -> None:
    """给默认禁用策略设置有效桶，要求公开和历史就绪降级、两个存活入口仍成功以及零次 SDK 活动。"""
    async with readiness_server(_s3_settings()) as context:
        assert context["config"].readiness_s3_strategy == "disabled"
        assert "readiness_s3_strategy" not in context["config"].model_fields_set
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"], "storage", _PRIVATE)
        await readiness_support.assert_legacy_ready(context, ready=False, markers=_PRIVATE)
        await readiness_support.assert_live_aliases(context, _PRIVATE)
        s3_probe.factory.assert_not_called()
        s3_probe.assert_no_client_activity()


@pytest.mark.parametrize(
    ("actual", "digest_source", "failed"),
    (
        pytest.param(b"probe", b"probe", None, id="match"),
        pytest.param(b"other", b"probe", "storage", id="same-length-bad-hash"),
        pytest.param(b"prob", b"prob", "storage", id="short"),
        pytest.param(b"probe!", b"probe!", "storage", id="one-byte-long"),
    ),
)
async def test_s3_read_object_checks_length_and_digest(
    readiness_server: readiness_support.ReadinessServer,
    s3_probe: _S3Probe,
    actual: bytes,
    digest_source: bytes,
    failed: Literal["storage"] | None,
) -> None:
    """仅允许一次精确 GetObject，成功须同时满足独立配置的长度和摘要；超出的探针读取只多一字节。"""
    stream = _TrackedStream(actual)
    with _tracked_body(stream, len(actual)) as body:
        s3_probe.factory.side_effect = functools.partial(
            s3_probe.open_client, queue=lambda stubber: _queue_body(stubber, body, len(actual))
        )
        async with readiness_server(_read_settings(digest_source)) as context:
            response = await context["client"].get("/health/ready")
            readiness_support.assert_public_response(response, context["config"], failed, _PRIVATE)
            s3_probe.assert_operation("GetObject", _OBJECT_PARAMS)
            assert stream.read_sizes == [6]
            assert stream.close_count == 1 and stream.closed


async def test_s3_explicit_head_bucket_does_not_read_objects(
    readiness_server: readiness_support.ReadinessServer, s3_probe: _S3Probe
) -> None:
    """显式查桶策略仅允许 HeadBucket 且无需对象键，成功时其余四项实际依赖也必须同时就绪。"""
    bucket_params = {"Bucket": _BUCKET}
    s3_probe.factory.side_effect = functools.partial(
        s3_probe.open_client,
        queue=lambda stubber: stubber.add_response(
            "head_bucket", {}, expected_params=bucket_params
        ),
    )
    async with readiness_server(_s3_settings(readiness_s3_strategy="head-bucket")) as context:
        assert context["config"].readiness_s3_object_key is None
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"], markers=_PRIVATE)
        s3_probe.assert_operation("HeadBucket", bucket_params)


async def test_s3_service_error_degrades_and_closes_client(
    readiness_server: readiness_support.ReadinessServer, s3_probe: _S3Probe
) -> None:
    """对象服务拒绝访问时不提供 Body，公开路由仅降级存储并对外隐藏服务诊断，仍按约关闭客户端。"""
    s3_probe.factory.side_effect = functools.partial(
        s3_probe.open_client,
        queue=lambda stubber: stubber.add_client_error(
            "get_object",
            service_error_code="AccessDenied",
            service_message=_SERVICE_MARKER,
            http_status_code=403,
            expected_params=_OBJECT_PARAMS,
        ),
    )
    async with readiness_server(_read_settings(b"probe")) as context:
        response = await context["client"].get("/health/ready")
        readiness_support.assert_public_response(response, context["config"], "storage", _PRIVATE)
        s3_probe.assert_operation("GetObject", _OBJECT_PARAMS)


async def test_s3_stream_read_error_degrades_and_closes_body_and_client(
    readiness_server: readiness_support.ReadinessServer, s3_probe: _S3Probe
) -> None:
    """真实流包装器将合成读取超时交给存储探针处理，公开结果须脱敏降级且流和客户端分别关闭一次。"""
    stream = _TrackedStream(b"probe", fail_read=True)
    with _tracked_body(stream, 5) as body:
        s3_probe.factory.side_effect = functools.partial(
            s3_probe.open_client, queue=lambda stubber: _queue_body(stubber, body, 5)
        )
        async with readiness_server(_read_settings(b"probe")) as context:
            response = await context["client"].get("/health/ready")
            readiness_support.assert_public_response(
                response, context["config"], "storage", _PRIVATE
            )
            s3_probe.assert_operation("GetObject", _OBJECT_PARAMS)
            assert stream.read_sizes == [6]
            assert stream.close_count == 1 and stream.closed


async def test_s3_factory_stall_degrades_before_worker_release(
    readiness_server: readiness_support.ReadinessServer,
    s3_probe: _S3Probe,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """用线程门闩占住工厂，验证实际两秒存储超时先于三秒外层截止，且过期请求不会重启仍拥有的工作。"""
    loop = asyncio.get_running_loop()
    entered = asyncio.Event()
    release = threading.Event()
    finished = threading.Event()
    cached_time = 20.0
    monkeypatch.setattr(readiness, "monotonic", lambda: cached_time)

    def stalled_factory(*args: object, **kwargs: object) -> Never:
        """向请求协程报告工厂已经进入后停在有界门闩，释放时返回合成 SDK 错误且不启用任何凭据提供器。"""
        # 工厂代理已保留精确调用参数供外层断言，门闩分支只控制进入和释放顺序，无需查看配置内容。
        del args, kwargs
        loop.call_soon_threadsafe(entered.set)
        try:
            if not release.wait(timeout=30):
                raise AssertionError("S3 factory gate was not released")
            raise exceptions.NoCredentialsError()
        finally:
            finished.set()

    s3_probe.factory.side_effect = stalled_factory
    async with readiness_server(_read_settings(b"probe")) as context:
        started = time.monotonic()
        request = asyncio.create_task(context["client"].get("/health/ready", timeout=10))
        try:
            await asyncio.wait_for(entered.wait(), timeout=10)
            response = await request
            elapsed = time.monotonic() - started
            readiness_support.assert_public_response(
                response, context["config"], "storage", _PRIVATE
            )
            _LOGGER.info("Readiness S3 factory deadline elapsed: %.3fs", elapsed)
            assert 1.9 <= elapsed < 2.8
            assert not release.is_set() and not finished.is_set()

            # 只使缓存过期，探针实际计时器继续工作；若旧线程的所有权丢失，工厂会再次收到调用。
            cached_time += 1
            response = await context["client"].get("/health/ready", timeout=10)
            readiness_support.assert_public_response(
                response, context["config"], "storage", _PRIVATE
            )
            assert not finished.is_set()
            s3_probe.assert_factory_call()
            s3_probe.assert_no_client_activity()
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
    assert finished.is_set()
    s3_probe.assert_factory_call()
    s3_probe.assert_no_client_activity()


def test_sdk_ledger_records_delete_attempt_before_stubber_rejects(s3_probe: _S3Probe) -> None:
    """在无数据库的真实 SDK 客户端上证明提前观察能记录未排队删除，并验证注销后原账本保持不变。"""
    client = s3_probe.open_client(
        "s3",
        endpoint_url=_ENDPOINT,
        region_name=_REGION,
        config=sdk_config.Config(
            connect_timeout=0.5, read_timeout=0.5, retries={"total_max_attempts": 1}
        ),
    )
    try:
        with pytest.raises(exceptions.UnStubbedResponseError):
            client.delete_object(Bucket=_BUCKET, Key=_KEY)
        assert s3_probe.operations == [("DeleteObject", _OBJECT_PARAMS)]

        client.meta.events.unregister(_EVENT, unique_id=_OBSERVER)
        with pytest.raises(exceptions.UnStubbedResponseError):
            client.delete_object(Bucket=_BUCKET, Key="synthetic/v02/unobserved-control")
        assert s3_probe.operations == [("DeleteObject", _OBJECT_PARAMS)]
        assert s3_probe.stubber is not None
        s3_probe.stubber.assert_no_pending_responses()
    finally:
        client.close()
    s3_probe.close.assert_called_once_with()
    s3_probe.factory.assert_not_called()
    s3_probe.transport.assert_not_called()
