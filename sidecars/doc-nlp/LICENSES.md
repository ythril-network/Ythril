# doc-nlp sidecar — third-party licenses

The sidecar's own code (`app.py`, `Dockerfile`) is part of Ythril and under Ythril's license. Its bundled
runtime dependencies are **all permissive (no copyleft)** and are enumerated for the top-level `NOTICE`:

| Component | Version | License | Notes |
|---|---|---|---|
| spaCy | 3.8.16 | MIT | Tokenizer, tagger, parser, named entities. |
| en_core_web_trf | 3.8.0 | MIT | spaCy's English transformer pipeline. |
| RoBERTa-base | (inside en_core_web_trf) | MIT | The transformer the pipeline is built on. |
| spacy-transformers | 1.4.0 | MIT | |
| Hugging Face Transformers | 4.53.2 | Apache-2.0 | |
| PyTorch (CPU) | 2.14.0 | BSD-3-Clause | |
| FastAPI | 0.115.6 | MIT | HTTP layer. |
| Starlette | (via FastAPI) | BSD-3-Clause | |
| Pydantic | (via FastAPI) | MIT | |
| Uvicorn | 0.34.0 | BSD-3-Clause | ASGI server. |
| Python (base image) | 3.13-slim | PSF License (+ Debian components) | Digest-pinned in the Dockerfile. |
