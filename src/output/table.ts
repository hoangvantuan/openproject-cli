interface StatusRow {
  readonly profile: string;
  readonly instance: string;
  readonly user: string;
}

export function renderStatusTable(row: StatusRow): string {
  const profileWidth = Math.max("PROFILE".length, row.profile.length);
  const instanceWidth = Math.max("INSTANCE".length, row.instance.length);

  return (
    `${"PROFILE".padEnd(profileWidth)}  ${"INSTANCE".padEnd(instanceWidth)}  USER\n` +
    `${row.profile.padEnd(profileWidth)}  ${row.instance.padEnd(instanceWidth)}  ${row.user}\n`
  );
}
