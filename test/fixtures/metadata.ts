import type { StoredCustomField } from "../../src/context/metadata.js";

export const INSTANCE = "https://op.example.dev";

/** The deterministic custom-field property key the API and the store share. */
export function customFieldKey(index: number): string {
  return `customField${String(index)}`;
}

export interface CustomFieldSpec {
  readonly index: number;
  readonly name: string;
  /** Schema type; anything beyond Boolean/User passes through as text. */
  readonly kind?: "Boolean" | "User";
}

/** A work-package schema fragment shaped like the instance's form schemas. */
export function schemaFragment(
  fields: ReadonlyArray<CustomFieldSpec>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    fields.map((field) => [
      customFieldKey(field.index),
      {
        writable: true,
        name: field.name,
        ...(field.kind === undefined ? {} : { type: field.kind }),
      },
    ]),
  );
}

/** Mirrors src/context/metadata.ts customFieldEntries over a fixture schema. */
export function customFieldsFromSchema(
  schema: Readonly<Record<string, Record<string, unknown>>>,
): Array<StoredCustomField> {
  return Object.entries(schema)
    .filter(([key]) => /^customField\d+$/.test(key))
    .map(([key, property]) => ({
      key,
      id: Number(key.slice("customField".length)),
      name: typeof property.name === "string" ? property.name : "",
      ...(property.type === "Boolean" ? { is_boolean: true as const } : {}),
      ...(property.type === "User" ? { is_user: true as const } : {}),
    }));
}

export interface BaseMetadataOptions {
  readonly statuses?: ReadonlyArray<Record<string, unknown>>;
}

/** The instance-wide metadata every wp test seeds into the cache. */
export function baseMetadata(
  options: BaseMetadataOptions = {},
): Record<string, unknown> {
  return {
    types: [
      { id: 2, name: "Task", is_milestone: false },
      { id: 6, name: "Bug", is_milestone: false },
    ],
    statuses:
      options.statuses
      ?? [
        { id: 1, name: "In progress", is_closed: false, is_default: true },
        { id: 5, name: "Closed", is_closed: true, is_default: false },
      ],
    priorities: [
      { id: 3, name: "High", is_default: false },
      { id: 4, name: "Low", is_default: false },
    ],
    instance: {
      url: INSTANCE,
      api_version: "v3",
      core_version: "13.4",
      fetched_at: "2026-08-23T00:00:00Z",
    },
  };
}

export type CustomFieldsByType = Readonly<
  Record<string, ReadonlyArray<StoredCustomField>>
>;

/**
 * The project-scoped vocabulary under a fixed project id; the custom
 * fields come from caller-built schemas so tests and production derive
 * their keys through one rule.
 */
export function projectVocabulary(
  customFields: CustomFieldsByType,
): Record<string, unknown> {
  return {
    project_id: 13,
    fetched_at: "2026-08-23T00:00:00Z",
    members: [
      { membership_id: 1, user_id: 7, name: "Linh Nguyen", type: "User", roles: [] },
    ],
    versions: [{ id: 31, name: "0.9.0", status: "open" }],
    categories: [{ id: 44, name: "Billing" }],
    activities: [],
    custom_fields: customFields,
  };
}
