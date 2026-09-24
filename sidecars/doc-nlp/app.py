"""
Ythril NLP sidecar (F-31) — candidate mentions for the conversation extractor.

The extractor's phase 4.1 asks this for the SPANS a conversation is about: spaCy's named entities and its
noun phrases, with character offsets. It proposes; it never decides. Whether a span is a thing worth an
entity (4.12), what type it is (4.2) and which existing entity it is (4.4) are Jev-style judgements the
server asks through its decision model — a misspelt or lowercase mention is the model's to recognise, not a
rule's to anticipate.

Why spaCy's transformer pipeline, measured on the ten committed LoCoMo extractions (recall over the entities
whose name the conversation says, on conversations nothing was tuned against): 96%, against 92% for spaCy's
large statistical model, 87% for wink-nlp and 88% for hand-written rules — with no rules to maintain.

Designed like doc-render: tiny, single-purpose, non-root, on an internal network with no database and no
egress. The model is baked into the image at build time, so nothing is downloaded at runtime.

Endpoints:
  GET  /health                         -> {"status": "ok", "model": "<name>-<version>"}
  POST /mentions  {"texts": [str, ...]} -> {"model": ..., "results": [{"spans": [{"text", "start", "end",
                                           "kind": "entity"|"phrase", "label"?, "head"?: {"start",
                                           "end"}}]}]}
"""
import os

import spacy
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL = os.environ.get("NLP_MODEL", "en_core_web_trf")
MAX_TEXTS = int(os.environ.get("NLP_MAX_TEXTS", "256"))
MAX_CHARS = int(os.environ.get("NLP_MAX_CHARS", str(200_000)))

# Entity labels that are amounts or times: phase 3 owns dates, and a number is never a thing on its own.
NOT_A_THING = {"DATE", "TIME", "CARDINAL", "ORDINAL", "QUANTITY", "PERCENT", "MONEY"}

# The lemmatizer is the one component the spans do not need.
nlp = spacy.load(MODEL, exclude=["lemmatizer"])
MODEL_ID = f"{nlp.meta['lang']}_{nlp.meta['name']}-{nlp.meta['version']}"

app = FastAPI(title="ythril-doc-nlp", docs_url=None, redoc_url=None, openapi_url=None)


class MentionsRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_ID}


@app.post("/mentions")
def mentions(req: MentionsRequest) -> dict:
    if len(req.texts) > MAX_TEXTS:
        raise HTTPException(status_code=413, detail=f"at most {MAX_TEXTS} texts per request")
    if sum(len(t) for t in req.texts) > MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"at most {MAX_CHARS} characters per request")
    results = []
    for doc in nlp.pipe(req.texts):
        spans = [
            {"text": e.text, "start": e.start_char, "end": e.end_char, "kind": "entity", "label": e.label_}
            for e in doc.ents if e.label_ not in NOT_A_THING
        ]
        # A phrase carries its head noun too: "a local church" is also "church", and the recall measured above
        # counts both — the head is what a later mention of the same thing is usually reduced to.
        spans += [
            {"text": c.text, "start": c.start_char, "end": c.end_char, "kind": "phrase",
             "head": {"start": c.root.idx, "end": c.root.idx + len(c.root.text)}}
            for c in doc.noun_chunks
        ]
        results.append({"spans": spans})
    return {"model": MODEL_ID, "results": results}
