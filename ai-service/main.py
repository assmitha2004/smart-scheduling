"""Entrypoint for serverless hosts (Vercel detects a top-level `main.py` exposing `app`)."""
from app.main import app

__all__ = ["app"]
