"""Readiness checks the database; liveness checks the running HTTP service."""

from sqlalchemy import text
from ..service import Problem
from .base import API


class HealthAPI(API):
    async def get(self, user_id: str | None = None) -> None:
        if self.action == "live":
            self.respond({"alive": True})
            return
        async with self.db.sessions() as s:
            if self.action == "health":
                await s.execute(text("SELECT 1"))
                self.respond({"ready": True})
            else:
                raise Problem(404, "NOT_FOUND", "API endpoint not found")
