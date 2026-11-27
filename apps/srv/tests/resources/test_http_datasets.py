"""用隔离的 HTTP 传输夹具检查签名原始字节、授权和完整分页，响应中的私有字段绝不能出现在预览中。"""

from copy import deepcopy
from datetime import UTC, datetime
import errno
import hashlib
import hmac

import httpx
import pytest

from veriq_server.service import Problem
from veriq_server.services.resource import check_document

REF = "00000000-0000-4000-8000-000000000001"
ENV = "00000000-0000-4000-8000-000000000002"
VERSION = "00000000-0000-4000-8000-000000000003"
NOW = datetime(2024, 1, 1, tzinfo=UTC)


def config():
    """构造同时具有重复键、空值与非 ASCII 参数的读取请求，映射只挑选一个上游业务字段。"""
    return {
        "schemaVersion": "2.0",
        "shape": "TABLE",
        "fields": {"label": {"type": "string", "required": True, "nullable": False}},
        "source": {
            "kind": "HTTP",
            "connectionRef": REF,
            "environmentVersionId": ENV,
            "method": "GET",
            "path": "/items",
            "query": [{"name": "q", "value": {"parameter": "search"}}, {"name": "q", "value": ""}],
            "headers": {},
            "parameters": {"search": "string"},
            "body": None,
            "auth": {
                "kind": "SIGNED",
                "algorithm": "HMAC_SHA256",
                "header": "X-Signature",
                "secretRef": "catalog",
                "secretVersionId": VERSION,
                "input": {
                    "op": "JOIN",
                    "separator": "|",
                    "parts": [{"op": "PATH"}, {"op": "QUERY"}, {"op": "TIMESTAMP"}, {"op": "BODY"}],
                },
            },
            "mapping": {"rows": "/items", "key": "/id", "values": {"label": "/name"}},
        },
    }


def connection():
    """部署登记精确路径、身份、环境和凭证版本，测试传输只在内存接收请求并不会联系此地址。"""
    from veriq_server.datasets.policy import DatasetConnection

    return DatasetConnection(
        workspace_id="workspace",
        environment_version_id=ENV,
        origin="https://upstream.example",
        address="93.184.216.34",
        routes={"/items": ["GET"]},
        user_ids=["actor"],
        credentials={
            "catalog": {
                "version_id": VERSION,
                "purposes": ["HMAC_SHA256", "AES256_GCM", "BASIC", "API_KEY"],
            }
        },
        auth_kinds=["HMAC_SHA256"],
        identity_id="dataset-reader",
    )


def bound(doc):
    from veriq_server.datasets.policy import bind_connection

    return bind_connection({REF: connection()}, "workspace", "actor", ENV, doc)


def test_custom_signature_matches_wire_bytes():
    """从独立固定字节计算预期摘要并同发送目标比较，参数值保留两次出现的顺序并编码中文和空格。"""
    doc = config()
    check_document("DATASET", {"kind": "DATASET", "document": doc})
    from veriq_server.datasets.request import build_request

    wire = build_request(bound(doc), {"search": "雪 +"}, NOW, lambda *_: "fixture")
    query = b"q=%E9%9B%AA%20%2B&q="
    expected = hmac.new(b"fixture", b"/items|" + query + b"|1704067200|", hashlib.sha256)
    assert wire.url.raw_path == b"/items?" + query
    assert wire.headers["X-Signature"] == expected.hexdigest()
    assert wire.headers["Host"] == "upstream.example"
    assert (
        wire.url.host == "93.184.216.34" and wire.extensions["sni_hostname"] == "upstream.example"
    )


@pytest.mark.parametrize(
    ("op", "query"),
    [("QUERY", b"q=abc&q=&page=1"), ("SORTED_QUERY", b"page=1&q=&q=abc")],
)
async def test_paged_signature_probe_matches_first_wire_request(op, query, caplog):
    """用独立摘要对照实际发出的第一页及离线签名验证，排序视图保留分页参数而不改变线上参数顺序。"""
    from veriq_server.datasets.request import fetch_rows, verify_signature
    from veriq_server.logging_context import inbound_trace, use_trace

    doc = config()
    doc["source"]["auth"]["input"] = {"op": op}
    doc["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "next": "/more",
        "maxPages": 2,
    }
    conf, args = bound(doc), {"search": "abc"}
    expected = hmac.new(b"fixture", query, hashlib.sha256).hexdigest()

    outbound_ids = []
    trace_id, span_id = "a" * 32, "b" * 16
    trace = inbound_trace({"x-trace-id": trace_id, "x-cspanid": span_id}, "dataset-request")

    def upstream(req):
        outbound_ids.append((req.headers.get("x-trace-id"), req.headers.get("x-cspanid")))
        assert req.url.query == b"q=abc&q=&page=1" and req.headers["X-Signature"] == expected
        return httpx.Response(200, stream=httpx.ByteStream(b'{"items":[],"more":false}'))

    def secret(*_):
        return "fixture"

    caplog.set_level(20)
    with use_trace(trace):
        assert await fetch_rows(conf, args, secret, transport=httpx.MockTransport(upstream)) == []
    records = [r for r in caplog.records if getattr(r, "veriq_tag", "") == "_com_http_success"]
    assert len(records) == 1
    fields = records[0].veriq_fields
    assert outbound_ids == [(trace_id, fields["cspanid"])]
    assert fields["traceid"] == trace_id
    assert fields["spanid"] == span_id and fields["cspanid"] != span_id
    probe = {"at": "2024-01-01T00:00:00Z", "expected": expected}
    assert verify_signature(conf, args, secret, probe) == {"signatureMatches": True}


async def test_dataset_request_uses_only_approved_connection():
    """目标和跳转均不得由数据源绕过部署登记，分页完成后才返回全部映射行且预览不会复述原文。"""
    doc = config()
    check_document("DATASET", {"kind": "DATASET", "document": doc})
    from veriq_server.datasets.request import fetch_rows, masked_preview
    from veriq_server.datasets.policy import bind_connection

    for ws, actor, env in [
        ("other", "actor", ENV),
        ("workspace", "other", ENV),
        ("workspace", "actor", REF),
    ]:
        with pytest.raises(Problem):
            bind_connection({REF: connection()}, ws, actor, env, doc)
    doc["source"]["path"] = "//unapproved.example"
    with pytest.raises(Problem):
        bound(doc)
    doc["source"]["path"] = "/items"
    doc["source"]["pagination"] = {
        "kind": "CURSOR",
        "parameter": "after",
        "next": "/next",
        "maxPages": 2,
    }
    calls = []

    def upstream(req):
        calls.append(req.url.params.get("after"))
        return httpx.Response(
            200,
            json={
                "items": [{"id": f"r{len(calls)}", "name": "private"}],
                "next": None if len(calls) == 2 else "next",
                "unmapped": "private",
            },
        )

    def stream(response):
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=httpx.ByteStream(response.content),
        )

    async def read(handler):
        return await fetch_rows(
            bound(doc),
            {"search": "x"},
            lambda *_: "fixture",
            transport=httpx.MockTransport(lambda req: stream(handler(req))),
        )

    result = await read(upstream)
    assert calls == [None, "next"]
    assert result == [{"key": f"r{i}", "values": {"label": "private"}} for i in [1, 2]]
    preview = masked_preview(result)
    assert (
        preview["rowCount"] == 2
        and "private" not in str(preview)
        and "unmapped" not in str(preview)
    )
    for response in [
        httpx.Response(302, headers={"Location": "https://other.example"}),
        httpx.Response(403, text="private"),
        httpx.Response(200, json={"items": [{"id": "only"}], "next": None}),
        httpx.Response(200, json={"items": [], "next": "loop"}),
        httpx.Response(200, json={"items": []}),
    ]:
        with pytest.raises(Problem) as failed:
            await read(lambda _, current=response: current)
        assert "private" not in str(failed.value)
    doc["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "next": "/more",
        "maxPages": 1,
    }
    with pytest.raises(Problem):
        await read(lambda _: httpx.Response(200, json={"items": [], "more": True}))


@pytest.fixture(name="dataset_deployment")
def shared_dataset_deployment():
    """每次真实服务端测试独享一份部署注册表，待工作区、当前用户及凭证版本创建后登记精确标识。"""
    return {}


async def test_http_preview_copy_publish_and_revocation(dataset_deployment, site, monkeypatch):
    """走资源的正式创建、预览、发布、复制与撤销入口，验证编辑权限与目标凭证绑定并检查错误不会含原文。"""
    from test_auth import login, setup
    from test_publish import create, publish
    from test_workspace import workspace
    from veriq_server.datasets import request

    client, db = site
    await setup(client)
    await login(client)
    ws = await workspace(client, "source")
    target = await workspace(client, "target")
    actor = (await client.get("/api/v1/auth/session")).json()["data"]["user"]["id"]
    cred_path = f"/api/v1/workspaces/{ws}/credentials"
    created = await client.post(
        cred_path,
        json={
            "secretRef": "catalog",
            "value": {"value": "fixture-only"},
            "allowedIdentityIds": ["dataset-reader"],
        },
    )
    assert created.status_code == 201, created.text
    version = created.json()["data"]["versionId"]
    dataset_deployment[REF] = connection().model_copy(
        update={
            "workspace_id": ws,
            "user_ids": [actor],
            "credentials": {
                "catalog": connection()
                .credentials["catalog"]
                .model_copy(update={"version_id": version})
            },
        }
    )
    doc = config()
    doc["source"]["auth"]["secretVersionId"] = version
    path = await create(client, ws, "remote", {"kind": "DATASET", "document": doc})
    data = {"document": doc, "arguments": {"search": "abc"}}
    seen = []

    def upstream(req):
        seen.append(req.url.raw_path)
        return httpx.Response(
            200, stream=httpx.ByteStream(b'{"items":[{"id":"one","name":"fixture-only"}]}')
        )

    monkeypatch.setattr(
        request, "open_transport", lambda: httpx.MockTransport(upstream), raising=False
    )
    result = await client.post(path + "/http-preview", json=data)
    assert result.status_code == 200, result.text
    assert result.json()["data"] == {"rowCount": 1, "sample": [{"fields": ["label"]}]}
    assert seen == [b"/items?q=abc&q="] and "fixture-only" not in result.text
    expected = hmac.new(b"fixture-only", b"/items|q=abc&q=|1704067200|", hashlib.sha256).hexdigest()
    probe = {"at": "2024-01-01T00:00:00Z", "expected": expected}
    for value, matches in [(expected, True), ("0" * 64, False)]:
        result = await client.post(
            path + "/http-preview", json={**data, "verifySignature": {**probe, "expected": value}}
        )
        assert result.status_code == 200, result.text
        assert result.json()["data"] == {"signatureMatches": matches}
    paged = deepcopy(doc)
    paged["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "next": "/more",
        "maxPages": 2,
    }
    expected = hmac.new(
        b"fixture-only", b"/items|q=abc&q=&page=1|1704067200|", hashlib.sha256
    ).hexdigest()
    result = await client.post(
        path + "/http-preview",
        json={
            **data,
            "document": paged,
            "verifySignature": {"at": "2024-01-01t00:00:00z", "expected": expected},
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["data"] == {"signatureMatches": True}
    assert len(seen) == 1
    published, _, _ = await publish(client, db, path)
    copied = await client.post(
        f"/api/v1/workspaces/{target}/resources/dataset-copies",
        json={
            "sourceWorkspaceId": ws,
            "sourceDatasetVersionId": published["id"],
            "key": "copy",
            "name": "copy",
        },
    )
    assert copied.status_code == 201, copied.text
    other = f"/api/v1/workspaces/{target}/resources/{copied.json()['data']['id']}"
    source = (await client.get(other + "/draft")).json()["data"]["content"]["document"]["source"]
    assert source["connectionRef"] is source["environmentVersionId"] is None
    assert source["auth"]["secretRef"] is source["auth"]["secretVersionId"] is None
    assert (await client.get(other + "/validation-preview")).status_code == 422
    assert (await client.post(other + "/http-preview", json=data)).status_code == 422

    doc["source"]["pagination"] = {"kind": "PAGE", "parameter": "p", "next": "/more", "maxPages": 2}

    async def revoke_during_read(req):
        assert (
            await client.post(f"{cred_path}/catalog/versions/{version}/revoke", json={})
        ).status_code == 200
        seen.append(req.url.raw_path)
        return httpx.Response(200, stream=httpx.ByteStream(b'{"items":[],"more":true}'))

    monkeypatch.setattr(request, "open_transport", lambda: httpx.MockTransport(revoke_during_read))
    assert (await client.post(path + "/http-preview", json=data)).status_code == 422
    assert (await client.post(path + "/http-preview", json=data)).status_code == 422
    assert len(seen) == 2


@pytest.mark.parametrize("binding", ["unbound", "registered"])
async def test_custom_managed_header_never_reaches_readable_draft(
    dataset_deployment, site, binding
):
    """正式资源入口在首次写入和修订时都拦截大小写不同的托管认证头，原草稿保持可读且普通头可继续编辑。"""
    from test_auth import login, setup
    from test_publish import create
    from test_workspace import workspace

    client, _ = site
    await setup(client)
    await login(client)
    ws = await workspace(client, "tenant")
    actor = (await client.get("/api/v1/auth/session")).json()["data"]["user"]["id"]
    base = f"/api/v1/workspaces/{ws}/resources"
    doc = config()
    source = doc["source"]
    if binding == "registered":
        source["auth"] = {"kind": "NONE"}
        dataset_deployment[REF] = connection().model_copy(
            update={
                "workspace_id": ws,
                "user_ids": [actor],
                "auth_kinds": ["NONE"],
                "request_headers": ["X-Locale"],
                "signature_header": "X-Managed-Proof",
            }
        )
    else:
        source.update(connectionRef=None, environmentVersionId=None)
        source["auth"].update(header="X-Managed-Proof", secretRef=None, secretVersionId=None)
    source["headers"] = {"X-Locale": "en"}
    content = {"kind": "DATASET", "document": doc}
    path = await create(client, ws, "ordinary", content)
    source["headers"]["X-Locale"] = "zh"
    edit = await client.put(path + "/draft", json={"revision": 1, "content": content})
    assert edit.status_code == 200, edit.text
    original = (await client.get(path + "/draft")).json()["data"]
    assert original["revision"] == 2 and original["content"] == content
    source["headers"]["x-MAnaged-Proof"] = "fixture-sensitive-marker"
    create_response = await client.post(
        base, json={"kind": "DATASET", "key": "rejected", "name": "rejected", "content": content}
    )
    edit = await client.put(path + "/draft", json={"revision": 2, "content": content})
    for response in (create_response, edit):
        assert response.status_code == 422 and "DATASET_HEADER_FORBIDDEN" in response.text
        assert "fixture-sensitive-marker" not in response.text
        assert "managed-proof" not in response.text.lower()
    assert (await client.get(path + "/draft")).json()["data"] == original
    listing = (await client.get(base)).json()["data"]["items"]
    assert [resource["key"] for resource in listing] == ["ordinary"]
    if binding == "registered":
        source["headers"] = {"X-Locale": "zh"}
        target = dataset_deployment[REF]
        # 无权访问的连接、其它环境或者不存在的版本必须给出同一结果，防止通过普通请求头探查部署批准记录。
        for overrides in (
            {"workspace_id": "other"},
            {"environment_version_id": VERSION},
            {"user_ids": []},
            None,
        ):
            if overrides is None:
                dataset_deployment.pop(REF)
            else:
                dataset_deployment[REF] = target.model_copy(update=overrides)
            denied = await client.put(path + "/draft", json={"revision": 2, "content": content})
            assert denied.status_code == 422
            assert denied.json()["code"] == "DATASET_CONNECTION_UNAVAILABLE"
        assert (await client.get(path + "/draft")).json()["data"] == original


def test_post_signs_actual_typed_body_and_requires_declared_arguments():
    """正文按真实 JSON 类型作规范编码，签名和请求共用字节；字符串化对象或额外参数不能伪装成声明类型。"""
    from veriq_server.datasets.request import build_request
    from veriq_server.datasets.policy import bind_connection

    doc = config()
    source = doc["source"]
    source.update(
        method="POST",
        parameters={"payload": "object", "search": "string"},
        body={"parameter": "payload"},
    )
    source["auth"]["input"] = {"op": "BODY"}
    check_document("DATASET", {"kind": "DATASET", "document": doc})
    approved = connection().model_copy(update={"routes": {"/items": ["POST"]}})
    auth = bind_connection({REF: approved}, "workspace", "actor", ENV, doc)
    args = {"payload": {"z": True, "a": "雪"}, "search": ""}
    wire = build_request(auth, args, NOW, lambda *_: "fixture")
    actual = '{"a":"雪","z":true}'.encode()
    assert wire.content == actual
    assert wire.headers["X-Signature"] == hmac.new(b"fixture", actual, hashlib.sha256).hexdigest()
    for invalid in [{**args, "extra": ""}, {**args, "payload": "{}"}, {"search": ""}]:
        with pytest.raises(Problem):
            build_request(auth, invalid, NOW, lambda *_: "fixture")


@pytest.mark.parametrize(
    ("body", "media", "expected"),
    [
        (
            {"form": [{"name": "q", "value": {"parameter": "search"}}, {"name": "q", "value": ""}]},
            "application/x-www-form-urlencoded",
            b"q=%E9%9B%AA+%2B&q=",
        ),
        ({"raw": {"parameter": "search"}}, "text/plain; charset=utf-8", "雪 +".encode()),
    ],
)
def test_form_and_raw_sign_exact_content(body, media, expected):
    """签名逐字节匹配实际表单或纯文本正文，同一请求中的头插值与签名所用时间戳来自同一个输入。"""
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import build_request

    doc = config()
    source = doc["source"]
    source.update(
        method="POST",
        parameters={"search": "string"},
        body=body,
        headers={"X-Time": "t={{request.timestamp}}"},
    )
    source["auth"]["input"] = {"op": "BODY"}
    check_document("DATASET", {"kind": "DATASET", "document": doc})
    target = connection().model_copy(
        update={"routes": {"/items": ["POST"]}, "request_headers": ["X-Time"]}
    )
    bound_doc = bind_connection({REF: target}, "workspace", "actor", ENV, doc)
    wire = build_request(bound_doc, {"search": "雪 +"}, NOW, lambda *_: "fixture")
    assert wire.content == expected and wire.headers["content-type"] == media
    assert wire.headers["x-time"] == "t=1704067200"
    assert wire.headers["x-signature"] == hmac.new(b"fixture", expected, hashlib.sha256).hexdigest()


@pytest.mark.parametrize(
    ("kind", "secret", "header", "expected"),
    [
        (
            "BASIC",
            {"username": "reader", "password": "example"},
            "Authorization",
            "Basic cmVhZGVyOmV4YW1wbGU=",
        ),
        ("API_KEY", "fixture", "X-Api-Key", "fixture"),
    ],
)
def test_request_authentication_is_bound_to_approved_method(kind, secret, header, expected):
    """不同鉴权方式使用同一凭证域检查，未经部署批准不能把用于签名的版本作为明文 API 密钥发送。"""
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import build_request

    doc = config()
    doc["source"]["auth"] = {
        "kind": kind,
        "secretRef": "catalog",
        "secretVersionId": VERSION,
        **({"header": header} if kind == "API_KEY" else {}),
    }
    check_document("DATASET", {"kind": "DATASET", "document": doc})
    with pytest.raises(Problem):
        bound(doc)
    target = connection().model_copy(
        update={
            "auth_kinds": [kind],
            "signature_header": header if kind == "API_KEY" else "X-Signature",
        }
    )
    conf = bind_connection({REF: target}, "workspace", "actor", ENV, doc)
    assert build_request(conf, {"search": "x"}, NOW, lambda *_: secret).headers[header] == expected


@pytest.mark.parametrize(
    ("case", "code"),
    [
        ("limit", "DATASET_RESPONSE_LIMIT"),
        ("timeout", "DATASET_REQUEST_TIMEOUT"),
        ("status", "DATASET_UPSTREAM_REJECTED"),
        ("incomplete", "DATASET_PAGINATION_INCOMPLETE"),
        ("connect", "DATASET_TRANSPORT_FAILED"),
    ],
)
async def test_http_failure_codes_never_return_partial_values(case, code):
    """超限、上游拒绝、断连、超时及缺失终止标记应有各自分类，调用者不会把残缺结果当成空数据或失败断言。"""
    from veriq_server.datasets.request import MAX_BYTES, fetch_rows

    doc = config()
    doc["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "maxPages": 2,
        "next": "/more",
    }

    def upstream(_request):
        if case == "timeout":
            raise httpx.ReadTimeout("private")
        if case == "connect":
            raise httpx.ConnectError("private")
        if case == "status":
            return httpx.Response(401, stream=httpx.ByteStream(b"private"))
        data = b"x" * (MAX_BYTES + 1) if case == "limit" else b'{"items":[]}'
        return httpx.Response(200, stream=httpx.ByteStream(data))

    with pytest.raises(Problem) as failure:
        await fetch_rows(
            bound(doc),
            {"search": ""},
            lambda *_: "fixture",
            transport=httpx.MockTransport(upstream),
        )
    assert failure.value.code == code and "private" not in str(failure.value)


@pytest.mark.parametrize(
    "addr",
    [
        "127.0.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "100.100.100.200",
        "168.63.129.16",
        "64:ff9b::a9fe:a9fe",
        "fe80::1",
    ],
)
def test_special_destinations_are_never_enabled_by_private_approval(addr):
    """即使运维批准了企业私网出口，元数据地址、回环、链路本地、组播与转换前缀都不能用于 HTTP 数据集。"""
    from pydantic import ValidationError
    from veriq_server.datasets.connection import DatasetConnection

    data = connection().model_dump()
    with pytest.raises(ValidationError):
        DatasetConnection.model_validate({**data, "allow_private": True, "address": addr})
    with pytest.raises(ValidationError):
        DatasetConnection.model_validate({**data, "address": "10.0.0.20"})
    assert (
        DatasetConnection.model_validate(
            {**data, "allow_private": True, "address": "10.0.0.20"}
        ).address
        == "10.0.0.20"
    )


async def test_explicit_pages_form_a_complete_tree_and_retries_only_approved_get():
    """分页顺序由参数显式表达，跨页父节点可迟到，重复键和超过深度限制的关系不得返回部分成功。"""
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import fetch_rows

    doc = config()
    doc["shape"] = "TREE"
    doc["source"]["mapping"].update(parentKey="/parent", order="/order")
    doc["source"]["pagination"] = {
        "kind": "PAGE",
        "parameter": "page",
        "next": "/more",
        "maxPages": 2,
    }
    target = connection().model_copy(update={"retry_reads": True})
    conf = bind_connection({REF: target}, "workspace", "actor", ENV, doc)
    calls = []

    def upstream(req):
        calls.append(req.url.params["page"])
        if len(calls) == 1:
            raise httpx.ConnectError("temporary") from ConnectionResetError(
                errno.ECONNRESET, "reset"
            )
        first = calls[-1] == "1"
        body = {
            "items": [
                {
                    "id": "leaf" if first else "root",
                    "parent": "root" if first else None,
                    "order": 0,
                    "name": "ok",
                }
            ],
            "more": first,
        }
        import json

        return httpx.Response(200, stream=httpx.ByteStream(json.dumps(body).encode()))

    rows = await fetch_rows(
        conf, {"search": ""}, lambda *_: "fixture", transport=httpx.MockTransport(upstream)
    )
    assert calls == ["1", "1", "2"] and [r["key"] for r in rows] == ["leaf", "root"]
    doc["source"]["mapping"]["parentKey"] = "/id"
    with pytest.raises(Problem):
        await fetch_rows(
            bound(doc),
            {"search": ""},
            lambda *_: "fixture",
            transport=httpx.MockTransport(upstream),
        )


def test_untrusted_headers_and_metadata_cannot_enter_drafts_or_private_routes():
    """系统和授权请求头不能作为草稿明文持久化，即使批准企业私网，常见云端 IPv6 元数据路由也必须拒绝。"""
    from pydantic import ValidationError
    from veriq_server.datasets.connection import DatasetConnection

    doc = config()
    for name in ["Authorization", "COOKIE", "x-api-key", "Proxy-Authorization", "Host"]:
        doc["source"]["headers"] = {name: "fixture"}
        with pytest.raises(Problem):
            check_document("DATASET", {"kind": "DATASET", "document": doc})
    for address in ["fd00:ec2::254", "fd20:ce::254"]:
        with pytest.raises(ValidationError):
            DatasetConnection.model_validate(
                {**connection().model_dump(), "address": address, "allow_private": True}
            )


def test_sorted_signature_and_encryption_verify_outside_builder():
    """独立解密检查认证密文的随机 nonce 与可验证排序结果，参数筛选仅用于签名且不改变请求的发送顺序。"""
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import build_request

    doc = config()
    doc["source"]["auth"].update(
        algorithm="AES256_GCM",
        input={"op": "SHA256", "input": {"op": "SORTED_QUERY", "names": ["q"]}},
    )
    conf = bind_connection(
        {REF: connection().model_copy(update={"auth_kinds": ["AES256_GCM"]})},
        "workspace",
        "actor",
        ENV,
        doc,
    )
    key = bytes(range(32))
    wires = [
        build_request(conf, {"search": "雪"}, NOW, lambda *_: base64.b64encode(key).decode())
        for _ in range(2)
    ]
    assert wires[0].headers["X-Signature"] != wires[1].headers["X-Signature"]
    for wire in wires:
        data = base64.b64decode(wire.headers["X-Signature"])
        assert (
            AESGCM(key).decrypt(data[:12], data[12:], None)
            == hashlib.sha256(b"q=&q=%E9%9B%AA").hexdigest().encode()
        )
        assert wire.url.raw_path == b"/items?q=%E9%9B%AA&q="


def test_credential_modes_cannot_be_substituted_on_the_same_origin():
    """同一个批准目标也可有两把用途不同的密钥，签名凭证即使属于同一连接也不能改作直接发送的令牌。"""
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.connection import DatasetConnection

    metadata = {
        **connection().model_dump(),
        "auth_kinds": ["HMAC_SHA256", "BEARER"],
        "credentials": {"catalog": {"version_id": VERSION, "purposes": ["HMAC_SHA256"]}},
    }
    policy = DatasetConnection.model_validate(metadata)
    doc = config()
    bind_connection({REF: policy}, "workspace", "actor", ENV, doc)
    doc["source"]["auth"] = {"kind": "BEARER", "secretRef": "catalog", "secretVersionId": VERSION}
    with pytest.raises(Problem):
        bind_connection({REF: policy}, "workspace", "actor", ENV, doc)


async def test_repeated_mapping_pointers_respect_total_mapped_byte_budget():
    """多个业务字段可选择同一响应位置，但投影后的总正文也必须受限，避免少量网络字节放大成超大执行参数。"""
    import json
    from veriq_server.datasets.request import fetch_rows

    doc = config()
    doc["fields"] = {f"f{i}": doc["fields"]["label"] for i in range(32)}
    doc["source"]["mapping"]["values"] = {name: "/value" for name in doc["fields"]}
    payload = json.dumps({"items": [{"id": "one", "value": "x" * 90000}]}).encode()
    transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=httpx.ByteStream(payload)))
    with pytest.raises(Problem) as failed:
        await fetch_rows(bound(doc), {"search": "x"}, lambda *_: "fixture", transport=transport)
    assert failed.value.code == "DATASET_RESPONSE_LIMIT"


async def test_tls_fixture_receives_signed_wire_target_and_checks_real_server_name():
    """通过回环 TLS 套接字捕获实际请求行、头及签名；测试证书只存匿名内存描述符，不创建密钥文件。"""
    import asyncio
    import os
    import ssl
    from datetime import timedelta
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import fetch_rows

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "upstream.example")])
    today = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(today - timedelta(days=1))
        .not_valid_after(today + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("upstream.example")]), critical=False
        )
        .sign(key, hashes.SHA256())
        .public_bytes(serialization.Encoding.PEM)
    )
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    with os.fdopen(os.memfd_create("dataset-test-certificate"), "wb") as memory:
        memory.write(
            cert
            + key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        memory.flush()
        tls.load_cert_chain(f"/proc/self/fd/{memory.fileno()}")
    verified = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    verified.load_verify_locations(cadata=cert.decode())
    names = []
    tls.set_servername_callback(lambda _sock, name, _context: names.append(name))
    received = []

    async def upstream(reader, writer):
        received.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(
            b'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"items":[]}'
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async with await asyncio.start_server(upstream, "127.0.0.1", 0, ssl=tls) as server:
        port = server.sockets[0].getsockname()[1]
        doc = config()
        doc["source"]["headers"] = {"X-Time": "{{request.timestamp}}"}
        for name in ("upstream.example", "other.example"):
            # 测试仅替换运维配置里已经验证的数字目的地址，以便在隔离机器上实际验证域名、SNI 与原始请求字节。
            target = connection().model_copy(
                update={
                    "origin": f"https://{name}:{port}",
                    "address": "127.0.0.1",
                    "request_headers": ["X-Time"],
                }
            )
            conf = bind_connection({REF: target}, "workspace", "actor", ENV, doc)
            read = fetch_rows(
                conf,
                {"search": "雪 +"},
                lambda *_: "fixture",
                transport=httpx.AsyncHTTPTransport(verify=verified),
            )
            if name == "upstream.example":
                assert await read == []
            else:
                with pytest.raises(Problem) as error:
                    await read
                assert error.value.code == "DATASET_TRANSPORT_FAILED"
    assert names == ["upstream.example", "other.example"]
    assert len(received) == 1
    start, *lines = received[0].strip().split(b"\r\n")
    headers = dict(line.split(b": ", 1) for line in lines)
    assert headers[b"Host"] == f"upstream.example:{port}".encode()
    assert start == b"GET /items?q=%E9%9B%AA%20%2B&q= HTTP/1.1"
    path, query = start.split(b" ")[1].split(b"?")
    signature = hmac.new(
        b"fixture", b"|".join([path, query, headers[b"X-Time"], b""]), hashlib.sha256
    ).hexdigest()
    assert headers[b"X-Signature"].decode() == signature


async def test_certificate_rejection_is_final_even_for_retryable_get():
    """TLS 证书错误不能因为连接允许重试便再次尝试，代理应直接报告脱敏的连接故障且不继续获取后续页面。"""
    import ssl
    from veriq_server.datasets.policy import bind_connection
    from veriq_server.datasets.request import fetch_rows

    calls = []

    def reject(req):
        calls.append(req.url.raw_path)
        raise httpx.ConnectError("tls") from ssl.SSLCertVerificationError("invalid certificate")

    target = connection().model_copy(update={"retry_reads": True})
    conf = bind_connection({REF: target}, "workspace", "actor", ENV, config())
    with pytest.raises(Problem):
        await fetch_rows(
            conf, {"search": ""}, lambda *_: "fixture", transport=httpx.MockTransport(reject)
        )
    assert len(calls) == 1
