import { openAsBlob } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Command } from "commander";

import { defineCollectionCommand, type CollectionRuntime } from "../core/define.js";
import {
  OpCliError,
  refuseCombined,
  unknownIfUnfinished,
  writeFailure,
  type WriteWording,
} from "../core/errors.js";
import { flattenHalRecord, formattableRaw } from "../core/hal.js";
import {
  apiGet,
  apiGetBytes,
  apiPostMultipartRaw,
} from "../core/http.js";
import { isIdForm } from "../context/resolve.js";
import type { ActiveProfile, ContextOverrides } from "../context/profile.js";

export interface AttachmentRuntime {
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeBytes: (bytes: Uint8Array) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

type RowResolver = (
  row: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export const ATTACHMENT_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "FILE NAME", field: "fileName" },
  { title: "SIZE", field: "fileSize" },
  { title: "CONTENT TYPE", field: "contentType" },
  { title: "AUTHOR", field: "author" },
  { title: "CREATED", field: "createdAt" },
] as const;

/**
 * One attachment as the flat record every attachment command shows: the
 * whole flattened resource (ADR-0003), with the Formattable description
 * reduced to its markdown. `--fields` is the projection.
 */
export function attachmentRow(element: unknown): Record<string, unknown> {
  const record = flattenHalRecord(element);
  if (!("description" in record)) {
    return record;
  }
  const description = formattableRaw(record.description);
  return { ...record, description: description === "" ? null : description };
}

/** The attributes of an attachment the API documents; a --fields name is checked against them. */
const ATTACHMENT_RECORD_SHAPE: Record<string, unknown> = Object.fromEntries(
  [
    "id", "title", "fileName", "fileSize", "description", "status",
    "contentType", "digest", "createdAt", "author", "container",
  ].map((field) => [field, null]),
);

/** What the attachment commands borrow from the work package surface. */
export interface AttachmentHelpers {
  /** The author-name resolver; the key names the user link of the row. */
  readonly authorResolver: (
    getPage: (path: string) => Promise<unknown>,
    key?: string,
  ) => RowResolver;
  readonly selectedFields: (
    raw: string | undefined,
    record: Record<string, unknown>,
    done?: string,
  ) => Array<string>;
  readonly renderRecord: (
    runtime: Pick<AttachmentRuntime, "write">,
    options: { json?: boolean; fields?: string },
    record: Record<string, unknown>,
    done?: string,
  ) => void;
  readonly openProfile: (
    runtime: Pick<AttachmentRuntime, "resolve" | "setJsonMode" | "write">,
    options: { json?: boolean; profile?: string; project?: string },
  ) => Promise<ActiveProfile>;
  readonly requireWpId: (reference: string) => void;
  readonly collectionRuntime: CollectionRuntime;
}

function requireId(reference: string, what: string): void {
  if (!isIdForm(reference)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${what} "${reference}" is not an id.`,
      `${what}s are addressed by their numeric id.`,
    );
  }
}

/** The size ceiling of the instance, or undefined when it names none. */
async function maximumFileSize(profile: ActiveProfile): Promise<number | undefined> {
  const configuration = await apiGet(
    profile.instanceUrl,
    profile.apiKey,
    "/api/v3/configuration",
  ) as { maximumAttachmentFileSize?: unknown } | null;
  const limit = configuration?.maximumAttachmentFileSize;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

/** What an upload says when its outcome cannot be known. */
const UPLOAD_WRITE = (reference: string): WriteWording => ({
  action: "upload",
  unknown: "whether the file was attached is unknown",
  check: `run op-cli wp attachments ${reference} before repeating the command.`,
});

async function pathKind(path: string): Promise<"file" | "directory" | "other" | "missing"> {
  try {
    const info = await stat(path);
    return info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

async function upload(
  runtime: AttachmentRuntime,
  helpers: AttachmentHelpers,
  reference: string,
  path: string,
  options: {
    description?: string;
    name?: string;
    json?: boolean;
    fields?: string;
    profile?: string;
    project?: string;
  },
): Promise<void> {
  helpers.requireWpId(reference);
  // --fields is checked against the columns every attachment record has,
  // so a typo is refused before the upload and a repeat cannot attach
  // the file twice.
  helpers.selectedFields(options.fields, ATTACHMENT_RECORD_SHAPE);
  // Every refusal that needs no network comes before the first request,
  // so a repeated command can never upload twice.
  const kind = await pathKind(path);
  if (kind !== "file") {
    throw new OpCliError(
      "USAGE_ERROR",
      kind === "missing"
        ? `file "${path}" does not exist or is not readable.`
        : `"${path}" is not a regular file.`,
      "pass the path of a readable file.",
    );
  }
  const fileName = options.name ?? basename(path);
  if (fileName === "") {
    throw new OpCliError("USAGE_ERROR", "--name must not be empty.");
  }
  const size = (await stat(path)).size;
  const profile = await helpers.openProfile(runtime, options);
  const limit = await maximumFileSize(profile);
  if (limit !== undefined && size > limit) {
    throw new OpCliError(
      "USAGE_ERROR",
      `"${path}" is ${String(size)} bytes; the instance accepts at most ${String(limit)} bytes per attachment.`,
      "attach a smaller file.",
    );
  }
  let blob: Blob;
  try {
    blob = await openAsBlob(path);
  } catch {
    throw new OpCliError(
      "USAGE_ERROR",
      `file "${path}" does not exist or is not readable.`,
      "pass the path of a readable file.",
    );
  }
  const form = new FormData();
  form.append("metadata", JSON.stringify({
    fileName,
    ...(options.description === undefined ? {} : { description: { raw: options.description } }),
  }));
  form.append("file", blob, fileName);
  const response = await unknownIfUnfinished(
    () => apiPostMultipartRaw(
      profile.instanceUrl,
      profile.apiKey,
      `/api/v3/work_packages/${reference}/attachments`,
      form,
    ),
    UPLOAD_WRITE(reference),
  );
  if (response.status < 200 || response.status >= 300) {
    throw writeFailure(response.status, response.body, UPLOAD_WRITE(reference));
  }
  helpers.renderRecord(
    runtime,
    options,
    attachmentRow(response.body),
    "the file was attached",
  );
}

async function download(
  runtime: AttachmentRuntime,
  helpers: AttachmentHelpers,
  reference: string,
  options: {
    output?: string;
    force?: boolean;
    json?: boolean;
    profile?: string;
    project?: string;
  },
): Promise<void> {
  requireId(reference, "attachment");
  // Bytes on stdout carry no JSON record, and there is no file to
  // overwrite: refuse the combination instead of ignoring a flag.
  const toStdout = options.output === "-";
  refuseCombined(
    [toStdout ? "--output -" : undefined, options.json === true ? "--json" : undefined],
    "--output - writes the file's bytes to stdout; drop --json or write to a path.",
  );
  refuseCombined(
    [toStdout ? "--output -" : undefined, options.force === true ? "--force" : undefined],
    "--output - writes to stdout, where there is no file to overwrite.",
  );
  const profile = await helpers.openProfile(runtime, options);
  const get = (path: string): Promise<unknown> =>
    apiGet(profile.instanceUrl, profile.apiKey, path);
  const contentPath = `/api/v3/attachments/${reference}/content`;

  if (toStdout) {
    runtime.writeBytes(await apiGetBytes(profile.instanceUrl, profile.apiKey, contentPath));
    return;
  }

  const meta = attachmentRow(await get(`/api/v3/attachments/${reference}`));
  // The server's name is never trusted as a path: only its last segment.
  const fileName = basename(typeof meta.fileName === "string" ? meta.fileName : "") || `attachment-${reference}`;
  let target = options.output ?? fileName;
  if (options.output !== undefined && await pathKind(options.output) === "directory") {
    target = join(options.output, fileName);
  }
  const existing = await pathKind(target);
  if (existing === "directory" || (existing !== "missing" && options.force !== true)) {
    throw new OpCliError(
      "USAGE_ERROR",
      existing === "directory"
        ? `"${target}" is a directory.`
        : `"${target}" already exists.`,
      existing === "directory"
        ? "pass --output with a file path."
        : "pass --force to overwrite it, or --output with another path.",
    );
  }
  const bytes = await apiGetBytes(profile.instanceUrl, profile.apiKey, contentPath);
  try {
    // "wx" keeps the no-overwrite promise even if the file appeared since
    // the check above.
    await writeFile(target, bytes, { flag: options.force === true ? "w" : "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new OpCliError(
      "USAGE_ERROR",
      code === "EEXIST"
        ? `"${target}" already exists.`
        : `cannot write "${target}": ${code ?? "unknown error"}.`,
      code === "EEXIST"
        ? "pass --force to overwrite it, or --output with another path."
        : "pass --output with a writable path.",
    );
  }
  if (options.json === true) {
    runtime.write(`${JSON.stringify({
      id: Number(reference),
      fileName,
      path: target,
      size: bytes.length,
    })}\n`);
    return;
  }
  runtime.write(`Saved ${target} (${String(bytes.length)} bytes).\n`);
}

/**
 * Work package attachments. `attach` and `attachment-download` are
 * separate commands rather than flags of `wp attachments`: the download
 * target is an attachment id, not a work package id, the same split as
 * `wp comment` and `wp comment-edit`. There is deliberately no delete.
 */
export function registerAttachmentCommands(
  wp: Command,
  runtime: AttachmentRuntime,
  helpers: AttachmentHelpers,
): void {
  wp.addCommand(defineCollectionCommand(
    {
      name: "attachments",
      description: "List the attachments of one work package",
      path: (id) => `/api/v3/work_packages/${id}/attachments`,
      row: attachmentRow,
      columns: ATTACHMENT_COLUMNS,
      resolve: (getPage) => helpers.authorResolver(getPage, "author"),
    },
    helpers.collectionRuntime,
  ));

  wp.command("attach")
    .description("Upload a file as an attachment of one work package")
    .argument("<id>", "work package id")
    .argument("<path>", "file to upload")
    .option("--description <text>", "description stored with the attachment")
    .option("--name <fileName>", "file name to store instead of the file's own")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action((reference: string, path: string, options: {
      description?: string;
      name?: string;
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => upload(runtime, helpers, reference, path, options));

  // Named after its target, like `comment-edit`: the argument is an
  // attachment id, never a work package id.
  wp.command("attachment-download")
    .description("Download one attachment by id (see `wp attachments`)")
    .argument("<attachment-id>", "id of the attachment, as listed by `wp attachments`")
    .option("--output <path>", "file or directory to write; - writes to stdout (default: the attachment's file name)")
    .option("--force", "overwrite an existing file")
    .option("--json", "emit the saved file as a JSON record")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action((reference: string, options: {
      output?: string;
      force?: boolean;
      json?: boolean;
      profile?: string;
      project?: string;
    }) => download(runtime, helpers, reference, options));
}
