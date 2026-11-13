# 控制面镜像只安装同一发行包中的 Python wheel 与离线依赖，固定基础镜像摘要并以非特权用户运行；构建期和运行期都不复制 Node、浏览器或开发仓库，目标镜像启动由独立 CI 验证。
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
COPY wheelhouse /opt/veriq/wheelhouse
COPY veriq_server-*.whl /opt/veriq/
RUN python -m pip install --no-index --find-links /opt/veriq/wheelhouse /opt/veriq/veriq_server-*.whl \
    && groupadd --gid 10001 veriq \
    && useradd --uid 10001 --gid veriq --no-create-home veriq \
    && mkdir -p /var/lib/veriq/artifacts /var/lib/veriq/issuer \
    && chown -R veriq:veriq /var/lib/veriq
ENV PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
WORKDIR /var/lib/veriq
EXPOSE 8888
HEALTHCHECK --interval=15s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8888/health/live', timeout=2)"
ENTRYPOINT ["python", "-B", "-m", "veriq_server", "--config", "/etc/veriq/veriq.json"]
CMD ["serve"]
