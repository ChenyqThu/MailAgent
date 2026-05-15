from pydantic import BaseModel


class ActionRequest(BaseModel):
    action: str  # mark_done, toggle_flag, toggle_read, archive
    payload: dict[str, str] | None = None


class BatchActionRequest(BaseModel):
    action: str
    email_ids: list[int]


class ViewActionRequest(BaseModel):
    action: str  # mark_browsed, mark_done
    view: str    # browse, pending
