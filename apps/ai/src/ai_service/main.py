from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Lumen AI Sidecar", version="0.1.0")


@app.get("/v1/healthz")
def healthz() -> dict:
    return {
        "vlm": {"ok": False, "model": "Qwen2-VL-7B-Instruct (not loaded in P0 stub)"},
        "llm": {"ok": False, "model": "Qwen2.5-7B-Instruct (not loaded in P0 stub)"},
    }


class FactsRequest(BaseModel):
    item_id: str
    images: list[str]
    seller_text: str
    category_hint: str | None = None


@app.post("/v1/vlm/facts")
def vlm_facts(req: FactsRequest) -> dict:
    return {
        "draft_id": f"draft_{req.item_id}",
        "facts": {
            "category": req.category_hint or "unknown",
            "visible_condition": "8.5/10",
            "defects": ["stub: 待 VLM 模型上线"],
            "suggested_start_cents": 50000,
            "high_risk_fields_disclaimer": ["brand", "authenticity", "material"],
            "confidence": 0.0,
        },
        "model": "stub",
        "model_version": "0.0.0",
        "latency_ms": 0,
    }


class HostRequest(BaseModel):
    auction_id: str
    trigger: str
    context: dict
    language: str = "zh-CN"
    max_tokens: int = 80


@app.post("/v1/llm/host")
def llm_host(req: HostRequest) -> dict:
    return {
        "final": f"[stub:{req.trigger}] AI 主持暂未上线",
        "model": "stub",
        "latency_ms": 0,
    }
