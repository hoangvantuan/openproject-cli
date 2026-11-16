# 2026-11-16 OpenProject v17.9.6 API Notes

Verified on 2026-11-16 against primary source files at `opf/openproject@v17.9.6`.

## VersionsAPI (`POST /api/v3/versions`)

Verified in `lib/api/v3/versions/versions_api.rb`, `version_representer.rb`, and `version_payload_representer.rb` at `opf/openproject@v17.9.6`:
- `POST /api/v3/versions` creates a version via `API::V3::Utilities::Endpoints::Create`.
- Writable attributes on create (`VersionPayloadRepresenter` + `VersionRepresenter`):
  - `name` (required string)
  - `description` (formattable `{ raw }` object via `formattable_property :description, plain: true`)
  - `startDate` (`date_property :start_date`, `YYYY-MM-DD` or `null`)
  - `endDate` (`date_property :effective_date, as: "endDate", writable: true`, `YYYY-MM-DD` or `null`)
  - `status` (`"open" | "locked" | "closed"`)
  - `sharing` (`"none" | "descendants" | "hierarchy" | "tree" | "system"`)
  - `_links.definingProject` (`{ href: "/api/v3/projects/<id>" }`, required on `new_record?` via `associated_project as: :definingProject`)
- Related issue: [Issue #60](https://github.com/hoangvantuan/openproject-cli/issues/60).

## QueriesAPI (`/api/v3/queries`)

Verified in `lib/api/v3/queries/queries_api.rb`, `queries_by_workspace_api.rb`, `query_representer.rb`, `query_payload_representer.rb`, `query_filter_instance_representer.rb`, `query_params_representer.rb`, `app/models/queries/queries/query_query.rb`, `app/contracts/queries/base_contract.rb`, and `config/constants/ar_to_api_conversions.rb` at `opf/openproject@v17.9.6`:
- **Collection listing (`GET /api/v3/queries`)**: Uses `Queries::Queries::QueryQuery` (`Query.visible(user)`). Registered filters under `app/models/queries/queries/filters/` include `project` (`=` for project IDs, `!*` for global queries with no project), `project_identifier`, `id`, and `updated_at`.
- **Default queries**:
  - Global default: `GET /api/v3/queries/default`
  - Project/workspace default: `GET /api/v3/workspaces/{id}/queries/default` (with `/api/v3/projects/{id}/queries/default` as fallback path if needed).
- **Single query & mutations**:
  - `GET /api/v3/queries/{id}` (optional `?valid_subset=true`)
  - `POST /api/v3/queries`
  - `PATCH /api/v3/queries/{id}`
  - `DELETE /api/v3/queries/{id}` (returns `204`)
  - `PATCH /api/v3/queries/{id}/star` (sets `starred: true`)
  - `PATCH /api/v3/queries/{id}/unstar` (sets `starred: false`)
- **Running a query**: `QueryRepresenter` returns `_links.results.href` pointing to `/api/v3/workspaces/{id}/work_packages?<queryParams>` (or `/api/v3/work_packages?<queryParams>` for global queries), plus `_embedded.results` on single-query responses (`QueryRepresenterResponse`).
- **Filter representation on Query payloads (`QueryFilterInstanceRepresenter` + `ARToAPIConversions`)**:
  - `_links.filter.href`: `/api/v3/queries/filters/<apiFilterName>`. Note conversions in `config/constants/ar_to_api_conversions.rb` and `PropertyNameConverter`: `assigned_to -> assignee`, `created_at -> createdAt`, `updated_at -> updatedAt`, `subproject -> subprojectId`, `version -> version` (`observed_in_version` / `observedInVersion`), `responsible -> responsible`.
  - `_links.operator.href`: `/api/v3/queries/operators/<CGI.escape(operator)>`.
  - Values: for `ar_object_filter?` filters, values travel under `_links.values` as `[{ href: ... }]`; for scalar/date/boolean filters, values travel as a top-level `values` array (`BooleanList` converts `true`/`false` booleans).
- **Sort, Columns, and Grouping links**:
  - `_links.sortBy`: array of `{ href: "/api/v3/queries/sort_bys/<column>-<asc|desc>" }`.
  - `_links.columns`: array of `{ href: "/api/v3/queries/columns/<column>" }`.
  - `_links.groupBy`: `{ href: "/api/v3/queries/group_bys/<column>" }` or `{ href: null }`.
  - `_links.project`: `{ href: "/api/v3/projects/<id>" }` or `{ href: null }` (for global queries).

## Related Pages

- [2026-11-16 Session Decisions](2026-11-16-session-decisions.md)
