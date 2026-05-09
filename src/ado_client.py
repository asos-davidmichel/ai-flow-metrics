"""
Azure DevOps API client.
No terminal input (input/print) here — only pure data functions.
"""

import base64
import re

import requests

BOARD_URL_PATTERN = re.compile(
    r"https://dev\.azure\.com/(?P<org>[^/]+)/(?P<project>[^/]+)"
    r"/_boards/board/t/(?P<team>[^/]+?)(?:/(?P<board_hint>[^/]+))?/?$"
)

API_VERSION = "7.1"


class ADOError(Exception):
    """Raised when the ADO API returns an error."""


def parse_board_url(url):
    """Parse an ADO board URL into (org, project, team, board_hint)."""
    match = BOARD_URL_PATTERN.match(url)
    if not match:
        raise ValueError(
            "URL does not match expected format.\n"
            "Expected: https://dev.azure.com/<org>/<project>/_boards/board/t/<team>/[<board>]"
        )
    return (
        match.group("org"),
        match.group("project"),
        match.group("team"),
        match.group("board_hint") or "",
    )


def make_auth_header(pat):
    token = base64.b64encode(f":{pat}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _get(url, headers):
    try:
        response = requests.get(url, headers=headers, timeout=15)
    except requests.exceptions.ConnectionError:
        raise ADOError("Could not reach dev.azure.com. Check your network.")
    except requests.exceptions.Timeout:
        raise ADOError("Request timed out.")

    if response.status_code == 401:
        raise ADOError("Authentication failed. Check your ADO_PAT.")
    if response.status_code == 403:
        raise ADOError("Permission denied. Your PAT may lack the required scopes.")
    if response.status_code == 404:
        raise ADOError(f"Resource not found (404): {url}")
    if not response.ok:
        raise ADOError(f"API returned {response.status_code}.\n{response.text[:300]}")
    return response.json()


def get_boards(org, project, team, headers):
    """Return a list of board dicts for the given team."""
    url = (
        f"https://dev.azure.com/{org}/{requests.utils.quote(project)}"
        f"/{requests.utils.quote(team)}/_apis/work/boards"
        f"?api-version={API_VERSION}"
    )
    data = _get(url, headers)
    return data.get("value", [])


def discover_board(boards, board_hint):
    """
    Match boards against an optional hint.

    Returns a dict:
      {
        "status": "matched" | "needs_selection" | "no_boards_found",
        "matched_board": {...} | None,
        "candidates": [...],   # boards to present for selection, if needed
        "boards": [...]        # all boards
      }
    """
    if not boards:
        return {"status": "no_boards_found", "matched_board": None, "candidates": [], "boards": []}

    if board_hint:
        matched = [b for b in boards if b["name"].lower() == board_hint.lower()]
        if len(matched) == 1:
            return {"status": "matched", "matched_board": matched[0], "candidates": [], "boards": boards}
        # partial/multiple match or no match — present candidates
        candidates = matched if matched else boards
        return {"status": "needs_selection", "matched_board": None, "candidates": candidates, "boards": boards}

    return {"status": "needs_selection", "matched_board": None, "candidates": boards, "boards": boards}


def get_board_columns(board_url, headers):
    """Return a list of column dicts for the given board URL."""
    url = f"{board_url}?api-version={API_VERSION}"
    data = _get(url, headers)
    return data.get("columns", [])


def get_board_rows(board_url, headers):
    """Return a list of swimlane dicts for the given board URL."""
    url = f"{board_url}/rows?api-version={API_VERSION}"
    data = _get(url, headers)
    rows = data.get("value", [])
    # Normalise the default (unnamed) swimlane
    for row in rows:
        if not row.get("name"):
            row["name"] = "(default)"
    return rows


def get_card_rule_settings(board_url, headers):
    """Return card styling rules (fill colour rules and swimlane rules) for the board."""
    url = f"{board_url}/cardrulesettings?api-version={API_VERSION}"
    data = _get(url, headers)
    return data.get("rules", {})


WORK_ITEM_FIELDS = [
    "System.Id",
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "System.BoardColumn",
    "System.BoardColumnDone",
    "System.BoardLane",
    "System.AssignedTo",
    "System.Tags",
    "System.Parent",
    "System.CreatedDate",
    "System.ChangedDate",
    "Microsoft.VSTS.Scheduling.Effort",
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Common.Priority",
]

LINK_TYPE_CHILD = "System.LinkTypes.Hierarchy-Forward"
LINK_TYPE_DEP_FWD = "System.LinkTypes.Dependency-Forward"
LINK_TYPE_DEP_REV = "System.LinkTypes.Dependency-Reverse"


def fetch_work_item_ids(org, project, team, work_item_types, headers):
    """Return all open work item IDs for the team, scoped to the given work item types."""
    url = (
        f"https://dev.azure.com/{org}/{requests.utils.quote(project)}"
        f"/_apis/wit/wiql?api-version={API_VERSION}"
    )
    types_list = ", ".join(f"'{t}'" for t in work_item_types)
    query = (
        f"SELECT [System.Id] FROM WorkItems "
        f"WHERE [System.TeamProject] = '{project}' "
        f"AND [System.AreaPath] UNDER '{project}\\{team}' "
        f"AND [System.WorkItemType] IN ({types_list}) "
        f"AND [System.State] NOT IN ('Closed', 'Removed') "
        f"ORDER BY [System.Id]"
    )
    try:
        response = requests.post(url, json={"query": query}, headers=headers, timeout=30)
    except requests.exceptions.ConnectionError:
        raise ADOError("Could not reach dev.azure.com. Check your network.")
    except requests.exceptions.Timeout:
        raise ADOError("WIQL request timed out.")

    if response.status_code == 401:
        raise ADOError("Authentication failed. Check your ADO_PAT.")
    if response.status_code == 403:
        raise ADOError("Permission denied.")
    if not response.ok:
        raise ADOError(f"WIQL query returned {response.status_code}.\n{response.text[:300]}")

    return [item["id"] for item in response.json().get("workItems", [])]


def _extract_links(relations, link_type):
    ids = []
    for rel in relations or []:
        if rel.get("rel") == link_type:
            url = rel.get("url", "")
            parts = url.rstrip("/").split("/")
            if parts[-1].isdigit():
                ids.append(int(parts[-1]))
    return ids


def _normalise_item(raw):
    fields = raw.get("fields", {})
    assignee = fields.get("System.AssignedTo")
    tags_raw = fields.get("System.Tags") or ""
    tags = [t.strip() for t in tags_raw.split(";") if t.strip()]
    relations = raw.get("relations", [])
    return {
        "id": fields.get("System.Id"),
        "type": fields.get("System.WorkItemType"),
        "title": fields.get("System.Title"),
        "state": fields.get("System.State"),
        "column": fields.get("System.BoardColumn"),
        "column_done": fields.get("System.BoardColumnDone", False),
        "swimlane": fields.get("System.BoardLane"),
        "assignee": assignee.get("displayName") if isinstance(assignee, dict) else assignee,
        "tags": tags,
        "parent_id": fields.get("System.Parent"),
        "children_ids": _extract_links(relations, LINK_TYPE_CHILD),
        "dependency_ids": (
            _extract_links(relations, LINK_TYPE_DEP_FWD)
            + _extract_links(relations, LINK_TYPE_DEP_REV)
        ),
        "created_date": fields.get("System.CreatedDate"),
        "changed_date": fields.get("System.ChangedDate"),
        "effort": fields.get("Microsoft.VSTS.Scheduling.Effort"),
        "story_points": fields.get("Microsoft.VSTS.Scheduling.StoryPoints"),
        "priority": fields.get("Microsoft.VSTS.Common.Priority"),
    }


def fetch_work_items(org, project, ids, headers, batch_size=200):
    """Fetch full work item details for a list of IDs. Returns normalised records."""
    fields_param = ",".join(WORK_ITEM_FIELDS)
    base = f"https://dev.azure.com/{org}/{requests.utils.quote(project)}/_apis/wit/workitems"

    # First pass: fetch fields
    fields_by_id = {}
    for i in range(0, len(ids), batch_size):
        batch = ids[i : i + batch_size]
        ids_param = ",".join(str(x) for x in batch)
        data = _get(f"{base}?ids={ids_param}&fields={fields_param}&api-version={API_VERSION}", headers)
        for raw in data.get("value", []):
            fields_by_id[raw["id"]] = raw.get("fields", {})

    # Second pass: fetch relations
    relations_by_id = {}
    for i in range(0, len(ids), batch_size):
        batch = ids[i : i + batch_size]
        ids_param = ",".join(str(x) for x in batch)
        data = _get(f"{base}?ids={ids_param}&$expand=relations&api-version={API_VERSION}", headers)
        for raw in data.get("value", []):
            relations_by_id[raw["id"]] = raw.get("relations", [])

    return [
        _normalise_item({"fields": fields_by_id[i], "relations": relations_by_id.get(i, [])})
        for i in ids
        if i in fields_by_id
    ]


def _build_history(updates, tracked_fields):
    """
    From a list of ADO update revisions, build an ordered list of changes
    for each tracked field: { field, old_value, new_value, changed_at }.
    """
    changes = []
    for update in updates:
        changed_at = update.get("revisedDate") or update.get("fields", {}).get(
            "System.ChangedDate", {}).get("newValue")
        fields = update.get("fields", {})
        for field in tracked_fields:
            if field in fields:
                entry = fields[field]
                old_val = entry.get("oldValue")
                new_val = entry.get("newValue")
                if old_val != new_val:
                    changes.append({
                        "field": field,
                        "old_value": old_val,
                        "new_value": new_val,
                        "changed_at": changed_at,
                    })
    return changes


def _history_to_spans(changes, field):
    """Convert a flat list of changes for one field into entry/exit spans."""
    spans = []
    field_changes = [c for c in changes if c["field"] == field]
    for i, change in enumerate(field_changes):
        left = field_changes[i + 1]["changed_at"] if i + 1 < len(field_changes) else None
        spans.append({
            "value": change["new_value"],
            "entered": change["changed_at"],
            "left": left,
        })
    return spans


def fetch_work_item_type_styles(org, project, work_item_types, headers):
    """
    Fetch color and icon metadata for the given work item types from the ADO API.

    Returns a dict keyed by type name:
      {
        "Bug": {"color": "#CC293D", "icon_id": "icon_insect"},
        "Product Backlog Item": {"color": "#009CCC", "icon_id": "icon_backlog"},
        ...
      }

    Types that cannot be fetched are omitted without error.
    """
    url = (
        f"https://dev.azure.com/{org}/{requests.utils.quote(project)}"
        f"/_apis/wit/workitemtypes?api-version={API_VERSION}"
    )
    try:
        data = _get(url, headers)
    except ADOError:
        return {}

    styles = {}
    all_types = {t["name"]: t for t in data.get("value", [])}
    for wit_name in work_item_types:
        entry = all_types.get(wit_name)
        if not entry:
            continue
        raw_color = entry.get("color") or ""
        # ADO returns color without the # prefix
        color = f"#{raw_color}" if raw_color and not raw_color.startswith("#") else raw_color
        icon = entry.get("icon", {})
        styles[wit_name] = {
            "color": color or "#718096",
            "icon_id": icon.get("id", ""),
            "icon_url": icon.get("url", ""),
        }
    return styles


def fetch_work_item_history(org, project, item_id, board_column_names, headers):
    """
    Fetch revision history for a single work item.
    board_column_names: ordered list of real board column names (from context.json),
                        used to detect regressions and distinguish board columns from
                        the virtual 'Backlog' pseudo-state.
    Returns a dict with board_entry_date, column_history, state_history, tag_history, regressions.
    """
    url = (
        f"https://dev.azure.com/{org}/{requests.utils.quote(project)}"
        f"/_apis/wit/workitems/{item_id}/updates?api-version={API_VERSION}"
    )
    data = _get(url, headers)
    updates = data.get("value", [])

    tracked = [
        "System.BoardColumn",
        "System.State",
        "System.Tags",
    ]
    changes = _build_history(updates, tracked)

    column_history = _history_to_spans(changes, "System.BoardColumn")
    state_history = _history_to_spans(changes, "System.State")
    tag_history = [c for c in changes if c["field"] == "System.Tags"]

    # board_column_names is the ordered list of real columns; "Backlog" is a virtual state
    board_col_index = {name: i for i, name in enumerate(board_column_names)}

    # Board entry date = first entry into a real board column (not the virtual Backlog state)
    board_entry_date = next(
        (span["entered"] for span in column_history if span["value"] in board_col_index),
        None,
    )

    # Regressions: moves where the destination column has a lower index than the source
    regressions = []
    board_moves = [span for span in column_history if span["value"] in board_col_index]
    for i in range(1, len(board_moves)):
        prev = board_moves[i - 1]["value"]
        curr = board_moves[i]["value"]
        if board_col_index[curr] < board_col_index[prev]:
            regressions.append({
                "from_column": prev,
                "to_column": curr,
                "at": board_moves[i]["entered"],
            })

    return {
        "id": item_id,
        "board_entry_date": board_entry_date,
        "column_history": column_history,
        "state_history": state_history,
        "tag_history": tag_history,
        "regressions": regressions,
    }
