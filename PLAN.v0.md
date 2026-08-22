# Kế hoạch: chuyển skill `openproject` sang combo CLI (npm) + Skill

Bản chốt. Ngày 2026-08-22.

## Toạ độ dự án

- Repo mã nguồn: `/Users/tuanhv/Desktop/PERSONAL/openproject-cli` (remote `git@github.com:hoangvantuan/openproject-cli.git`, branch `main`, chưa có commit)
- Tên package npm: `op-cli` (đã kiểm, còn trống)
- Tên lệnh: `op-cli` là chính, `opj` là alias ngắn
- Repo plugin liên quan: `/Users/tuanhv/Desktop/PERSONAL/shun_claude_tools/shun_claude_plugin`, skill Python cũ nằm ở branch `feature/openproject-skill`

## 0. Quyết định đã chốt

| # | Hạng mục | Chốt | Lý do gốc |
|---|---|---|---|
| 1 | Ngôn ngữ | TypeScript / Node 20+ | Yêu cầu publish npm. API OpenProject là REST/HAL thuần nên port là dịch cơ học |
| 2 | Phạm vi | Phủ 100% 9 domain, nhưng thiết kế lại: ~110 hàm Python gộp còn ~75 lệnh nhờ dùng cờ thay hàm riêng | Giữ độ phủ, giảm bề mặt phải bảo trì |
| 3 | Vị trí | Repo riêng `hoangvantuan/openproject-cli`, plugin chỉ chứa skill mỏng | CLI có nhịp phát hành riêng (semver, npm, issue cộng đồng) |
| 4 | Config | CLI sở hữu hoàn toàn; tách cấu hình khỏi cache; rà bỏ 11 field thừa | Xoá 5/8 cạm bẫy khỏi prompt bằng cách đổi cấu trúc |
| 5 | Artefact | MỘT package, CHỈ có `bin`, không xuất SDK | Không cần semver cho API TS, không cần `.d.ts`, không cần export map |
| 6 | Nền tảng | Tự viết lớp HTTP (~250 dòng, `fetch` sẵn có). KHÔNG dùng `op-client` | `op-client` thiếu 6/9 domain, bản cuối 2022, OAuth2 only, enum type hardcode, không có schema/custom field |
| 7 | Tên | package `op-cli`; binary chính `op-cli`, alias `opj` | `op-cli` còn trống trên npm; không lấy `op` vì xung đột 1Password CLI |
| 8 | Hình dạng lệnh | Danh từ trước, động từ sau, 2 tầng: `op-cli wp list` | Chuẩn `gh`/`az`; skill dạy `--help` thay vì liệt kê 75 lệnh |
| 9 | Output | Bảng cho người là mặc định + `--json` tường minh + `OP_CLI_OUTPUT=json` | Cộng đồng là người dùng bề mặt mặc định; agent dùng cờ tường minh |
| 10 | Ngữ cảnh | Nhiều profile = (instance + token + project mặc định) | Sửa sau rất đắt vì nằm trong đường dẫn cache và mọi lệnh |
| 11 | Secret | Ưu tiên biến môi trường; mặc định lưu `credentials.json` chmod 600; keychain để sau | CI và agent cần env; keychain khó cross-platform |
| 12 | Giấy phép | MIT + NOTICE tuyên bố không liên kết OpenProject GmbH | Gọi REST không lây GPLv3; tên gợi sản phẩm chính thức nên phải nói rõ |
| 13 | Ngôn ngữ tài liệu | README + SKILL tiếng Anh, thêm `README.vi.md` | Sản phẩm cộng đồng quốc tế |

## 1. Vì sao không dùng `op-client@1.4.2`

Đã tải tarball và đọc `src/`:

- Chỉ 6 entity: WP, Project, Status, Type, User, CustomOption. Thiếu TimeEntry, Membership, Group, Notification, Query, Attachment, Wiki, Document, Priority, Role, Version, Category, Schema.
- Bản cuối phát hành 2022-05; README ghi "tested with OpenProject v10 và v11" (nay v15/16).
- Chỉ OAuth2 qua `client-oauth2` (đã ngừng bảo trì). Ta dùng API key Basic auth.
- `reflect-metadata` + decorator legacy, TS 3.9, `@types/node` 8 → xung đột với TS 5 decorators.
- `TypeEnum`/`StatusEnum` hardcode → sai với instance có type tuỳ biến (Bug UAT, TechDebt, KPT).
- Không có schema/custom field resolution, tức là thiếu đúng phần khó nhất.

Kết luận: lấy về vẫn phải viết 70%, cộng thêm nợ kỹ thuật. Tự viết lớp HTTP mỏng.

## 2. Kiến trúc repo

```
openproject-cli/
  package.json            # bin: { "op-cli", "opj" }, name: "op-cli", type: module, engines: node >=20
  src/
    bin.ts                # entry, parse argv, dispatch, map lỗi -> exit code
    core/
      http.ts             # fetch + Basic auth + retry 429/5xx + timeout
      paginate.ts         # async generator theo _links.nextByOffset
      hal.ts              # bóc _embedded.elements, _links -> id
      filters.ts          # build filters/sortBy JSON của OpenProject
      errors.ts           # OpCliError { code, status, hint }
      duration.ts         # ISO 8601 duration <-> giờ thập phân
    context/
      profile.ts          # đọc/ghi config.toml + credentials.json
      cache.ts            # đọc/ghi/làm mới cache metadata
      resolve.ts          # tên -> id (type, status, priority, member, version, category, activity, custom field)
    commands/
      auth.ts cache.ts project.ts wp.ts time.ts user.ts group.ts member.ts
      attach.ts doc.ts wiki.ts query.ts notify.ts admin.ts api.ts doctor.ts skill.ts completion.ts
    output/
      table.ts json.ts fields.ts
  skill/
    SKILL.md              # NGUỒN SỰ THẬT DUY NHẤT của skill
    references/*.md
  test/
    unit/**  fixtures/**  integration/**
  .github/workflows/{ci.yml,release.yml}
```

Phụ thuộc runtime tối thiểu: `commander` (parse), `smol-toml` (config). Bảng tự vẽ, màu bằng ANSI thủ công, không `chalk`. Không `axios`, không `dotenv` (Node 20+ có `--env-file`, và CLI đọc env trực tiếp).

## 3. Mô hình ngữ cảnh: profile

`~/.config/op-cli/config.toml` (người viết, chia sẻ được, KHÔNG chứa token):

```toml
default_profile = "work"

[profiles.work]
url = "https://op.company.com"
project = 13          # project mặc định, ghi đè bằng --project
output = "table"

[profiles.selfhost]
url = "http://172.16.0.48:8080"
```

`~/.config/op-cli/credentials.json`, chmod 600: `{ "work": { "api_key": "..." } }`

Thứ tự ưu tiên khi giải ngữ cảnh: cờ dòng lệnh > biến môi trường (`OPENPROJECT_URL`, `OPENPROJECT_API_KEY`, `OP_CLI_PROFILE`, `OP_CLI_PROJECT`) > profile đang chọn > profile mặc định. Có env đầy đủ thì CLI chạy được mà không cần file nào, phục vụ CI và container.

Cache: `~/.cache/op-cli/<sha1(url)>/instance.json` và `.../project-<id>.json`. Xoá lúc nào cũng an toàn, tự dựng lại. Có TTL mềm 7 ngày: quá hạn thì CLI vẫn chạy nhưng in cảnh báo lên stderr, không tự gọi API để tránh lệnh chậm bất ngờ.

## 4. Schema cache sau khi rà soát

Bỏ (11 field, có lý do từng cái):

| Field bỏ | Lý do |
|---|---|
| `generated_at` | Trùng vai với `updated_at`; giữ một mốc `fetched_at` |
| `instance.user_login`, `instance.user_email` | Không dùng để resolve; là dữ liệu cá nhân, không nên nằm trong file dễ commit |
| `project.description` | Dài, không phục vụ tra id |
| `project.active`, `project.public` | Không lệnh nào đọc |
| `members[].principal_href` | Suy ra được từ `user_id` |
| `members[].roles[].href` | Chỉ cần `id` + `title` |
| `types[].color`, `statuses[].color`, `priorities[].color` | Bảng không tô màu theo instance |
| `statuses[].position`, `priorities[].position` | Sắp xếp ngay lúc fetch rồi bỏ field |
| `versions[].start_date`, `.end_date`, `.description` | Không phục vụ resolve; cần thì gọi `op-cli project versions` |

Thêm (4 mục, đều có công dụng cụ thể):

| Field thêm | Công dụng |
|---|---|
| `members[].type` = User \| Group \| Placeholder | Memberships trộn cả group; assignee phải phân biệt |
| `custom_fields[type][key].allowed_values` (chỉ khi <= 50 phần tử) | Resolve và validate custom field dạng dropdown |
| `activities[]` (id, name, is_default) theo project | `op-cli time log --activity "Development"`; khắc phục việc `list_activities()` trả rỗng |
| `instance.api_version`, `instance.core_version` | `op-cli doctor` cảnh báo khi instance quá cũ |

Giữ: `project{id,identifier,name}`, `types[]{id,name,is_milestone}`, `statuses[]{id,name,is_closed,is_default}`, `priorities[]{id,name,is_default}`, `versions[]{id,name,status}`, `categories[]{id,name}`, `members[]{membership_id,user_id,name,type,roles[]{id,title}}`, `custom_fields{}`, `instance{url,user{id,name,admin},...}`.

Kết quả: file cache nhỏ hơn khoảng 40%, không còn chứa email, và `is_milestone`/`is_default`/`version.status` được dùng để validate đầu vào chứ chỉ để hiển thị.

## 5. Lớp resolve: nơi 5 cạm bẫy biến mất

Mọi cờ nhận cả tên lẫn id. Quy tắc: giá trị toàn chữ số coi là id; ngược lại tra cache; miss thì làm mới cache một lần rồi thử lại; vẫn miss thì exit 1 kèm danh sách giá trị hợp lệ gần đúng nhất.

```
op-cli wp create --type "User Story" --status New --assignee "Hung" \
  --version "Sprint 12" --field "Excute Point=5" -s "Tên task"
```

Cạm bẫy trong SKILL.md cũ và cách xử lý:

| Cạm bẫy cũ | Sau khi có CLI |
|---|---|
| type/status/priority id hardcode | Lớp resolve, biến mất khỏi tài liệu |
| custom field theo project và type | `--field "Tên=Giá trị"`, CLI tự tra schema đúng type |
| `get_schema()` cần cả project_id và type_id | Nội bộ CLI, biến mất |
| member theo tên | `--assignee "Hung"`, trùng tên thì báo lỗi mơ hồ kèm id |
| `hours` là ISO 8601 duration | CLI luôn xuất `hours` số thập phân, giữ `hours_iso` trong `--json` |
| generator không có `len()` | Không còn khái niệm, output là mảng JSON hoặc bảng |
| `list_time_entries` filter sai tên | `op-cli time list --wp 675`, CLI tự dựng `entity_type`+`entity_id` |
| `get_work_packages_time` trả dict | `op-cli time list --wp 675,598,577` trả mảng phẳng có cột `wp` |
| identifier khác name | `op-cli project get` nhận id, identifier hoặc tên, tự phân biệt |

Đây là điểm cốt lõi của cả bản chuyển đổi: 8 cảnh báo trong prompt được thay bằng cấu trúc trong code. SKILL.md từ 598 dòng còn khoảng 150.

## 6. Bề mặt lệnh (~75 lệnh, phủ 100% bản Python)

```
auth      login | logout | list | use <profile> | status
cache     init [project] | refresh | show | clear
          types | statuses | priorities | members | versions | categories | fields | activities
project   list | get | create | update | delete | copy | star | unstar | versions | categories | types
wp        list | get | create | update | delete | comment | comments | history
          relations | relate | unrelate | schema
time      list | get | log | update | delete | report
user      list | get | me | create | update | delete | lock | unlock
group     list | get | create | update | delete | add | remove
member    list | get | add | update | remove
attach    list | get | upload | download | delete
doc       list | get
wiki      get | update
query     list | get | create | update | delete | star | unstar | columns
notify    list | get | read | unread | read-all | count
admin     roles | config
api       <GET|POST|PATCH|DELETE> <path> [--data <json>]
doctor    | completion <shell> | skill install
```

Gộp lại từ bản Python (không mất năng lực, chỉ đổi cách gọi):

| Hàm Python bỏ | Thay bằng |
|---|---|
| `list_open_statuses`, `list_closed_statuses` | `cache statuses --open` / `--closed` |
| `list_unread`, `list_by_reason` | `notify list --unread --reason mentioned` |
| `get_work_package_time`, `get_work_packages_time` | `time list --wp 675,598` |
| `get_user_time_today` | `time list --user me --from today` |
| `get_query_default` | `query get default` |
| `toggle_favorite` | `project star` / `project unstar` |
| `list_project_types` | `project types` |
| `get_activity` | `cache activities` |
| `list_wiki_attachments` | `attach list --wiki <id>` |
| `check_connection` | `doctor` |
| `load_session_config`, `require_config`, `is_config_initialized`, `print_config_summary`, 8 hàm `get_*_id` | Nội bộ CLI, không phải lệnh |

Quy ước xuyên suốt: `--project`, `--profile`, `--json`, `--fields`, `--limit`, `--all`, `--yes`, `--dry-run`, `--quiet`.

## 7. Hợp đồng output và lỗi

Mặc định bảng, tự tắt màu và tắt bo góc khi không phải TTY. `--json` in mảng JSON đã làm sạch HAL (id, các field phẳng, `_links` gọn thành `{id, name}`).

Mã thoát:

| Code | Nghĩa |
|---|---|
| 0 | Thành công |
| 1 | Dùng sai (thiếu tham số, resolve thất bại, xác nhận bị từ chối) |
| 2 | Lỗi API (4xx/5xx ngoài các nhóm dưới) |
| 3 | Lỗi xác thực hoặc thiếu quyền (401, 403) |
| 4 | Không tìm thấy (404) |
| 5 | Xung đột (409, lockVersion cũ) |
| 6 | Lỗi mạng hoặc quá thời gian |

Lỗi in ra stderr; ở chế độ `--json` là `{"error":{"code":"TYPE_NOT_FOUND","status":null,"message":"...","hint":"Run: op-cli cache types"}}`. `code` là chuỗi ổn định, có trong tài liệu, để skill và script bắt được mà không phải so khớp văn bản.

An toàn: mọi lệnh xoá cần `--yes` khi không có TTY; `project delete` và `user delete` bắt gõ lại identifier; `update` tự lấy `lockVersion` mới rồi thử lại tối đa một lần, sau đó trả exit 5.

Ghi hàng loạt: `op-cli wp create --stdin < wps.json` nhận mảng JSON, in kết quả từng dòng NDJSON kèm trạng thái, không dừng ở lỗi đầu tiên (`--fail-fast` để đổi hành vi).

## 8. Skill đi kèm trong repo CLI

`skill/SKILL.md` là nguồn sự thật duy nhất. Nội dung không liệt kê 75 lệnh (đó là việc của `--help`), mà dạy 5 điều CLI không tự nói được:

1. Mở đầu phiên: `op-cli auth status --json`, nếu thiếu cache thì `op-cli cache init <project>`.
2. Bản đồ ý định sang lệnh: một bảng "muốn X thì chạy Y" khoảng 25 dòng.
3. Luôn dùng `--json --fields ...` khi cần phân tích; không parse bảng.
4. Đọc `code` và mã thoát; bảng code lỗi kèm hành động khắc phục.
5. Cạm bẫy còn lại sau khi CLI đã hấp thụ phần lớn: quyền admin, Documents API chỉ đọc, giới hạn phân trang, `--all` có thể rất chậm.

`op-cli skill install [--global|--project]` copy `skill/` vào `~/.claude/skills/openproject/` hoặc `./.claude/skills/openproject/`. Đây là mắt khoá của combo: cài CLI xong là có luôn skill đúng phiên bản, không lệch version giữa tài liệu và lệnh.

Kiểm tra tự động trong CI: một test đọc mọi khối lệnh trong `SKILL.md` và chạy `--help` tương ứng, thất bại nếu skill nhắc tới lệnh hoặc cờ không tồn tại. Đây là cách chặn cứng việc tài liệu trôi khỏi code.

## 9. Quan hệ với repo plugin này

- Nguồn gốc skill nằm ở repo CLI.
- `skills/openproject/` trong repo plugin trở thành bản sao đồng bộ: một GitHub Action ở repo CLI mở PR sang repo plugin mỗi lần `skill/` đổi. Không sửa tay ở repo plugin.
- 81 file Python hiện tại trên branch `feature/openproject-skill` không merge vào main. Đóng branch lại, giữ như mốc lịch sử, và ghi trong PR rằng bản Python đã được thay bằng CLI.
- Cập nhật `CLAUDE.md` và `README.md` của plugin: mục `openproject` mô tả là skill mỏng cần `npm i -g op-cli`, giống cách `m365-*` và `trello` đang làm.

## 10. Test và CI

- Unit (vitest + `undici` MockAgent) trên fixture HAL thật lấy từ instance rồi làm sạch: mỗi lệnh kiểm ba nhánh (thành công, resolve thất bại, lỗi API).
- Test riêng cho phần dễ sai: `duration.ts` (ISO 8601 hai chiều), `paginate.ts` (biên trang), `resolve.ts` (trùng tên, phân biệt id với tên, cache miss), `filters.ts` (khớp đúng JSON mà OpenProject chờ đợi).
- Integration (không chạy trong PR từ fork): `docker compose` dựng OpenProject community, seed một project, chạy vòng đời thật tạo/sửa/xoá.
- Kiểm tính nhất quán skill với `--help` như mục 8.
- CI: Node 20/22/24 trên ubuntu và macos. Phát hành bằng changesets, `npm publish` qua OIDC trusted publishing kèm provenance, không đặt token trong secret.
- `--version` in cả version CLI và version instance khi có cache, giúp báo lỗi từ cộng đồng có đủ thông tin.

## 11. Lộ trình

| Mốc | Nội dung | Xong khi |
|---|---|---|
| M1 Xương sống | repo, CI, `core/*`, `context/*`, `auth`, `cache`, `doctor`, `api` | `op-cli auth login` rồi `op-cli api GET /projects` chạy được; `op-cli cache init` sinh file cache theo schema mục 4 |
| M2 Lõi công việc | `project`, `wp`, `time` kèm resolve và `report` | Làm được toàn bộ việc thường ngày mà không cần `op-cli api` |
| M3 Phủ hết | `user`, `group`, `member`, `attach`, `doc`, `wiki`, `query`, `notify`, `admin` | Bảng đối chiếu ở mục 6 không còn dòng nào thiếu |
| M4 Skill | `skill/SKILL.md`, `references/`, `op-cli skill install`, test nhất quán skill | Claude làm trọn 5 tình huống mẫu chỉ bằng CLI |
| M5 Công bố 0.1.0 | README (Anh + Việt), NOTICE nhãn hiệu, completion, changesets | `npm i -g op-cli` trên máy sạch dùng được trong 3 lệnh |
| M6 Dọn nhà | Đồng bộ skill sang repo plugin, cập nhật CLAUDE.md/README.md, đóng branch Python | Plugin trỏ CLI, không còn 81 file Python trong đường dẫn dùng thật |

Ước lượng khối lượng: khoảng 1.200 dòng cho `core` + `context`, 2.000 dòng cho 15 nhóm lệnh, 1.500 dòng test, 400 dòng skill và tài liệu.

## 12. Rủi ro và cách hoá giải

| Rủi ro | Hoá giải |
|---|---|
| `op-cli api` quá tiện, Claude dùng thay lệnh chuẩn | SKILL.md xếp `op-cli api` vào mục "chỉ khi không có lệnh chuyên biệt"; `op-cli api` in cảnh báo stderr gợi ý lệnh tương đương khi nhận diện được path |
| Custom field khác nhau giữa các instance làm test giòn | Fixture sinh từ schema, test resolve theo dữ liệu bảng chứ không hardcode `customField8` |
| Nhãn hiệu OpenProject | NOTICE và câu đầu README tuyên bố không liên kết; không dùng logo của họ |
| Cache lệch sau khi admin đổi cấu hình | TTL mềm 7 ngày cảnh báo; resolve miss thì tự làm mới một lần; `op-cli cache refresh` in ra phần thay đổi |
| Sửa xuyên hai repo mất tính nguyên tử | Skill có nguồn duy nhất ở repo CLI, đồng bộ bằng bot; test nhất quán skill chạy ở repo CLI |
| Phiên bản OpenProject cũ thiếu endpoint | `op-cli doctor` đọc `core_version` và cảnh báo; ghi rõ hỗ trợ v13+ trong README |
