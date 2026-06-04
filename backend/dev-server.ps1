$env:PYTHONIOENCODING = "utf-8"

uvicorn app.main:app --reload --host 127.0.0.1 --port 18080
