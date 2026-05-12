from pydantic import BaseModel


class ActionRequest(BaseModel):
    action: str  # mark_done, toggle_flag, toggle_read, archive
    payload: dict[str, str] | None = None
