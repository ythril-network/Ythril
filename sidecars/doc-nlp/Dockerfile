# Ythril NLP sidecar (F-31) — candidate mentions for the conversation extractor, via spaCy's transformer
# pipeline. Bundled like the other models (`DOC_NLP_REPLICAS=0` leaves it out); PyTorch + RoBERTa, ~3 GB.
# Hardened like doc-render: non-root, internal network only, no egress. The model is installed at BUILD time
# (a pinned wheel), so the running container never downloads anything. Licenses: LICENSES.md.
FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin nlp

WORKDIR /app

# CPU-only PyTorch first, from its own index, so the CUDA build (several GB) is never pulled in.
RUN pip install --no-cache-dir torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir \
    https://github.com/explosion/spacy-models/releases/download/en_core_web_trf-3.8.0/en_core_web_trf-3.8.0-py3-none-any.whl

COPY app.py .

# Transformers looks for a writable cache even when everything it needs is installed; the rootfs is read-only.
ENV HF_HOME=/tmp/hf HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

USER nlp
EXPOSE 8102

# One worker: inference is CPU-bound and the model is ~0.5 GB in memory; scale with replicas.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8102", "--workers", "1"]
