import type { StoredCustomField } from "../../src/context/metadata.js";

export const INSTANCE = "https://op.example.dev";

/** The deterministic custom-field property key the API and the store share. */
export function customFieldKey(index: number): string {
  return `customField${String(index)}`;
}

export interface CustomFieldOption {
  readonly id: number;
  readonly name: string;
}

export interface CustomFieldSpec {
  readonly index: number;
  readonly name: string;
  /**
   * Schema type; anything beyond Boolean/User/CustomOption passes through
   * as text. The "[]" prefix is how the instance spells a multi-valued
   * field.
   */
  readonly kind?: "Boolean" | "User" | "CustomOption" | "[]CustomOption";
  /** Selectable values of a list field, as the create form embeds them. */
  readonly options?: ReadonlyArray<CustomFieldOption>;
  /** The schema marks the field required. */
  readonly required?: boolean;
}

export const CUSTOM_OPTIONS_HREF = "/api/v3/custom_options/";

/**
 * A work-package schema fragment shaped like the instance's create form:
 * a list field carries its options as full CustomOption resources under
 * _embedded.allowedValues and as bare links under _links.allowedValues,
 * exactly the two shapes the store reads.
 */
export function schemaFragment(
  fields: ReadonlyArray<CustomFieldSpec>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    fields.map((field) => [
      customFieldKey(field.index),
      {
        writable: true,
        ...(field.kind === undefined ? {} : { type: field.kind }),
        name: field.name,
        ...(field.required === undefined ? {} : { required: field.required }),
        ...(field.options === undefined ? {} : {
          location: "_links",
          _embedded: {
            allowedValues: field.options.map((option) => ({
              _type: "CustomOption",
              id: option.id,
              value: option.name,
              _links: {
                self: { href: `${CUSTOM_OPTIONS_HREF}${String(option.id)}` },
              },
            })),
          },
          _links: {
            allowedValues: field.options.map((option) => ({
              href: `${CUSTOM_OPTIONS_HREF}${String(option.id)}`,
              title: option.name,
            })),
          },
        }),
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
    .map(([key, property]) => {
      const kind = typeof property.type === "string" ? property.type : "";
      const embedded = (property._embedded ?? {}) as {
        allowedValues?: ReadonlyArray<{ id: number; value: string }>;
      };
      const options = (embedded.allowedValues ?? []).map((option) => ({
        id: option.id,
        name: option.value,
      }));
      const isList = kind.replace(/^\[\]/, "") === "CustomOption";
      return {
        key,
        id: Number(key.slice("customField".length)),
        name: typeof property.name === "string" ? property.name : "",
        // A list field keeps its options with their ids; every other kind
        // keeps only the names the schema listed.
        ...(!isList && options.length > 0
          ? { allowed_values: options.map((option) => option.name) }
          : {}),
        ...(kind === "Boolean" ? { is_boolean: true as const } : {}),
        ...(kind === "User" ? { is_user: true as const } : {}),
        ...(isList ? { is_list: true as const, allowed_options: options } : {}),
        ...(property.required === true ? { is_required: true as const } : {}),
        ...(kind.startsWith("[]") ? { is_multi: true as const } : {}),
      };
    });
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
