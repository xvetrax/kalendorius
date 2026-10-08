import type { OAuthConnectionRow } from "@/lib/oauth-service";

export type CalendarAccountError = {
  connectionId: string;
  accountId: string;
  accountLabel: string;
  message: string;
  status?: number;
};

export function calendarAccountLabel(connection: OAuthConnectionRow): string {
  return connection.display_label || connection.provider_email || "Paskyra";
}

export function calendarAccountError(
  connection: OAuthConnectionRow,
  error: unknown,
): CalendarAccountError {
  const value = error as { message?: unknown; status?: unknown };
  return {
    connectionId: String(connection.id),
    accountId: connection.provider_account_id,
    accountLabel: calendarAccountLabel(connection),
    message:
      typeof value?.message === "string" && value.message
        ? value.message
        : "Paskyros duomenų atnaujinti nepavyko.",
    ...(typeof value?.status === "number" ? { status: value.status } : {}),
  };
}

/** Runs provider calls in small batches so one user cannot create an API burst. */
export async function allSettledLimited<T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let index = 0; index < values.length; index += limit) {
    results.push(...(await Promise.allSettled(values.slice(index, index + limit).map(work))));
  }
  return results;
}
