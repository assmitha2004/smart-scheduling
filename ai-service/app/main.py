from datetime import date
from fastapi import FastAPI
from pydantic import BaseModel, Field
import re
app = FastAPI(title="Smart Scheduling AI Service", version="1.0.0")
class ExtractRequest(BaseModel):
    text: str = Field(min_length=3, max_length=10000)
class DraftTask(BaseModel):
    title: str
    estimated_minutes: int = 60
    priority: str = "MEDIUM"
    due_date: date | None = None
class BriefingRequest(BaseModel):
    tasks: list[dict]
@app.get("/health")
def health(): return {"status":"ok","service":"smart-scheduling-ai"}
@app.post("/extract-tasks")
def extract_tasks(payload: ExtractRequest):
    chunks=[x.strip(" -•\t") for x in re.split(r"[\n;]+",payload.text) if x.strip(" -•\t")]
    drafts=[DraftTask(title=x[:160]).model_dump(mode="json") for x in chunks[:20]]
    return {"drafts":drafts,"requires_user_approval":True,"mode":"rule_based_draft_extraction"}
@app.post("/daily-briefing")
def daily_briefing(payload: BriefingRequest):
    tasks=payload.tasks
    ranked=sorted(tasks,key=lambda t:(t.get("dueAt") or "9999",{"URGENT":0,"HIGH":1,"MEDIUM":2,"LOW":3}.get(t.get("priority"),2)))[:5]
    return {"date":date.today().isoformat(),"summary":f"Review these {len(ranked)} highest-priority items first.","priorities":ranked,"mode":"grounded_summary"}
