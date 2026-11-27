"""Check result logging at the SMTP and database boundaries."""

import smtplib

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from veriq_server import db, outbound
from veriq_server.delivery import SMTPDelivery
from veriq_server.settings import Settings


@pytest.mark.parametrize("rejected", [False, True])
async def test_smtp_emits_one_result_without_message_content(monkeypatch, caplog, rejected):
    class SMTPConnection:
        def __init__(self, host, port, *, timeout):
            if rejected:
                raise smtplib.SMTPConnectError(421, b"private SMTP reply")

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def send_message(self, message):
            return {}

    monkeypatch.setattr(smtplib, "SMTP", SMTPConnection)
    smtp = SMTPDelivery(
        Settings.model_construct(
            smtp_host="localhost", smtp_from="sender@example.com", smtp_security="none"
        )
    )
    caplog.set_level(20)
    if rejected:
        with pytest.raises(smtplib.SMTPConnectError):
            await smtp.send("recipient@example.com", "private subject", "private body")
    else:
        await smtp.send("recipient@example.com", "private subject", "private body")
    records = [r for r in caplog.records if getattr(r, "veriq_tag", "").startswith("_com_smtp")]
    assert [record.veriq_tag for record in records] == [
        "_com_smtp_failure" if rejected else "_com_smtp_success"
    ]
    for marker in (
        "recipient@example.com",
        "private subject",
        "private body",
        "private SMTP reply",
    ):
        assert marker not in caplog.text


def test_database_emits_one_result_per_cursor_operation_without_sql(caplog):
    engine = create_engine("sqlite://")
    db.instrument_database(engine)
    caplog.set_level(20)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT 'private-result-marker'")).scalar_one() == (
            "private-result-marker"
        )
        with pytest.raises(DBAPIError):
            connection.execute(text("SELECT private_missing_column"))
    engine.dispose()
    records = [r for r in caplog.records if getattr(r, "veriq_tag", "").startswith("_com_mysql")]
    assert [(r.veriq_tag, r.veriq_fields["method_name"]) for r in records] == [
        ("_com_mysql_success", "CONNECT"),
        ("_com_mysql_success", "SELECT"),
        ("_com_mysql_failure", "SELECT"),
    ]
    fields = repr([record.veriq_fields for record in records])
    assert "private-result-marker" not in fields
    assert "private_missing_column" not in fields


def test_database_operation_is_independent_of_log_sink_failure(monkeypatch):
    def broken_sink(*args, **kwargs):
        raise OSError("log sink unavailable")

    monkeypatch.setattr(outbound, "log", broken_sink)
    engine = create_engine("sqlite://")
    db.instrument_database(engine)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT 42")).scalar_one() == 42
        with pytest.raises(DBAPIError):
            connection.execute(text("SELECT missing_column"))
    engine.dispose()


def test_database_connect_failure_is_recorded_before_cursor_execution(tmp_path, caplog):
    engine = create_engine(f"sqlite:///{tmp_path}/private-directory/db")
    db.instrument_database(engine)
    with pytest.raises(DBAPIError):
        engine.connect()
    engine.dispose()
    records = [r for r in caplog.records if getattr(r, "veriq_tag", "") == "_com_mysql_failure"]
    assert len(records) == 1
    fields = records[0].veriq_fields
    assert fields["method_name"] == "CONNECT"
    assert fields["errno"] == "OperationalError"
    assert "private-directory" not in repr(fields)
