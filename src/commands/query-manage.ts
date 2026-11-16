import type { Command } from "commander";

import { OpCliError, unknownIfUnfinished, writeFailure } from "../core/errors.js";
import { apiDeleteRaw, apiPatchRaw } from "../core/http.js";
import {
  addQueryScopeOptions,
  checkQueryScopeFlags,
  connectQuery,
  flattenQueryRecord,
  QUERIES_COLLECTION,
  renderQueryRecord,
  resolveQueryRef,
  type QueryRuntime,
  type QueryScopeOptions,
} from "./query.js";

/** The default query is a view of the scope, not a stored query. */
function refuseDefault(reference: string): void {
  if (reference === "default") {
    throw new OpCliError(
      "USAGE_ERROR",
      "the default query is not a saved query and cannot be modified.",
      "pass the id or exact name of a saved query; run op-cli query list to see them.",
    );
  }
}

/** The numeric id a reference names; "default" never reaches here. */
async function resolveStoredId(
  connection: Awaited<ReturnType<typeof connectQuery>>,
  reference: string,
): Promise<number> {
  const ref = await resolveQueryRef(connection, reference);
  if (ref.kind !== "id") {
    refuseDefault("default");
    throw new OpCliError("INTERNAL_ERROR", "a saved query reference resolved to the default.");
  }
  return ref.id;
}

type StarOptions = QueryScopeOptions & { readonly fields?: string };

function registerStar(
  query: Command,
  runtime: QueryRuntime,
  verb: "star" | "unstar",
): void {
  const past = verb === "star" ? "starred" : "unstarred";
  addQueryScopeOptions(
    query
      .command(verb)
      .description(
        verb === "star"
          ? "Mark one saved query as a favourite of the current user"
          : "Remove one saved query from the current user's favourites",
      )
      .argument("<id-or-name>", "query id or exact name")
      .option("--json", "emit a flat JSON record")
      .option("--fields <list>", "comma-separated fields to show"),
  ).action(async (reference: string, options: StarOptions) => {
    runtime.setJsonMode(options.json === true);
    checkQueryScopeFlags(options);
    refuseDefault(reference);
    const connection = await connectQuery(runtime, options);
    const id = await resolveStoredId(connection, reference);
    const { instanceUrl, apiKey } = connection.profile;
    const wording = {
      action: verb,
      unknown: `whether the query was ${past} is unknown`,
      check: `run op-cli query get ${String(id)} to check its starred state before repeating the command.`,
    };
    const response = await unknownIfUnfinished(
      () => apiPatchRaw(instanceUrl, apiKey, `${QUERIES_COLLECTION}/${String(id)}/${verb}`, {}),
      wording,
    );
    if (response.status >= 400) {
      throw writeFailure(response.status, response.body, wording);
    }
    renderQueryRecord(
      runtime,
      options,
      flattenQueryRecord(response.body),
      `query ${String(id)} was ${past}`,
    );
  });
}

function registerDelete(query: Command, runtime: QueryRuntime): void {
  addQueryScopeOptions(
    query
      .command("delete")
      .description("Delete one saved query after explicit confirmation")
      .argument("<id-or-name>", "query id or exact name")
      .option("--yes", "confirm the deletion"),
  ).action(async (reference: string, options: QueryScopeOptions & { readonly yes?: boolean }) => {
    // The guard fires before any resolution or traffic.
    if (options.yes !== true) {
      throw new OpCliError(
        "USAGE_ERROR",
        `query delete refuses to remove "${reference}" without confirmation; `
          + "deleting a query is irreversible.",
        "repeat the command with --yes to confirm the deletion.",
      );
    }
    checkQueryScopeFlags(options);
    refuseDefault(reference);
    const connection = await connectQuery(runtime, options);
    const id = await resolveStoredId(connection, reference);
    const wording = {
      action: "delete",
      unknown: "whether the query was deleted is unknown",
      check: "run op-cli query list before repeating the command.",
    };
    const { instanceUrl, apiKey } = connection.profile;
    const response = await unknownIfUnfinished(
      () => apiDeleteRaw(instanceUrl, apiKey, `${QUERIES_COLLECTION}/${String(id)}`),
      wording,
    );
    if (response.status >= 400) {
      throw writeFailure(response.status, response.body, wording);
    }
    runtime.write(`Deleted query ${String(id)}.\n`);
  });
}

export function registerQueryManage(query: Command, runtime: QueryRuntime): void {
  registerStar(query, runtime, "star");
  registerStar(query, runtime, "unstar");
  registerDelete(query, runtime);
}
