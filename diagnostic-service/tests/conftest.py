"""Isolate tests from the developer's diagnostic-service/.env.

Values already in the environment win over the .env file, so pinning them
here (before app modules are imported) keeps tests on the mock provider and
guarantees they never send a real request to Groq with a real key.
"""

import os

os.environ["NEXLINK_DIAG_PROVIDER"] = "mock"
os.environ["GROQ_API_KEY"] = ""
