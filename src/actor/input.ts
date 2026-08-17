import { z } from 'zod';

import type { FilterCriteria } from '../domain/filters.js';

/**
 * Input validation (brief §4). Zod at the boundary: malformed input fails loudly with a
 * readable message and a non-zero exit, rather than producing a plausible-looking empty
 * dataset that nobody investigates.
 */

const handleList = z
  .array(z.string().trim().min(1))
  .transform((values) => values.map((value) => value.replace(/^@/, '')));

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'must be an ISO-8601 date, e.g. "2026-08-01" or "2026-08-01T12:00:00Z"',
  });

export const ProxyConfigurationSchema = z.object({
  useApifyProxy: z.boolean().optional(),
  apifyProxyGroups: z.array(z.string()).optional(),
  apifyProxyCountry: z.string().optional(),
  proxyUrls: z.array(z.string().url()).optional(),
});

export const ActorInputSchema = z
  .object({
    /**
     * The three targets (brief §2a). `fromUsers` and `tweetIds` map to guest-reachable
     * operations; `searchTerms` is the stretch surface and is served through discovery
     * (README §2), not through X's own gated search.
     */
    fromUsers: handleList.optional(),
    tweetIds: z.array(z.string().trim().regex(/^\d+$/, 'must be a numeric tweet id')).optional(),
    searchTerms: z.array(z.string().trim().min(1)).optional(),

    hashtags: z
      .array(z.string().trim().min(1))
      .transform((values) => values.map((value) => value.replace(/^#/, '')))
      .optional(),

    since: isoDate.optional(),
    until: isoDate.optional(),
    language: z.string().trim().length(2).optional(),

    minLikes: z.number().int().nonnegative().optional(),
    minRetweets: z.number().int().nonnegative().optional(),
    minReplies: z.number().int().nonnegative().optional(),

    onlyVerified: z.boolean().optional(),
    mediaType: z.enum(['images', 'video', 'links', 'text_only']).optional(),

    // §4 states the default for retweets only; we default both and document the choice.
    includeReplies: z.boolean().default(false),
    includeRetweets: z.boolean().default(false),

    sortBy: z.enum(['latest', 'top']).default('latest'),

    /**
     * The *requested* cap. Deliberately unbounded here: a `"maximum": 10` in the input
     * schema would break paying users, and a limit expressed in the input is exactly the
     * client-side artifact brief §6 rejects as protection. The server-side gate in
     * `domain/entitlement.ts` is the only enforcement (SPEC.md §3.1).
     */
    maxResults: z.number().int().positive().default(100),

    proxyConfiguration: ProxyConfigurationSchema.optional(),

    // --- operational knobs, all optional ---
    maxConcurrency: z.number().int().positive().max(20).default(4),
    maxPagesPerAccount: z.number().int().positive().default(25),
    /**
     * The cost ceiling. Measured: a low-selectivity keyword run matched 9 tweets out of
     * 10,527 fetched and spent 518 requests / 91 MB getting there. Without a budget, run
     * cost is bounded only by how many accounts exist.
     */
    maxRequests: z.number().int().positive().default(500),
    maxAccounts: z.number().int().positive().default(50),
    expansionDepth: z.number().int().min(0).max(2).default(1),
    maxSessions: z.number().int().positive().max(50).default(5),
  })
  /**
   * Brief §4: a run needs a *target*. `hashtags` is not one — it is a post-filter over
   * the timelines a target produced, so a hashtags-only run has nothing to fetch from.
   */
  .refine(
    (input) =>
      (input.fromUsers?.length ?? 0) > 0 ||
      (input.tweetIds?.length ?? 0) > 0 ||
      (input.searchTerms?.length ?? 0) > 0,
    { message: 'At least one of `fromUsers`, `tweetIds` or `searchTerms` is required' },
  )
  .refine(
    (input) =>
      input.since === undefined ||
      input.until === undefined ||
      new Date(input.since).getTime() <= new Date(input.until).getTime(),
    { message: '`since` must not be later than `until`' },
  );

export type ActorInput = z.infer<typeof ActorInputSchema>;

export function parseInput(raw: unknown): ActorInput {
  const parsed = ActorInputSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(input)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid Actor input:\n${details}`);
}

/** The filter view of the input. Everything else is operational. */
export function toFilterCriteria(input: ActorInput): FilterCriteria {
  return {
    ...(input.searchTerms === undefined ? {} : { searchTerms: input.searchTerms }),
    ...(input.fromUsers === undefined ? {} : { fromUsers: input.fromUsers }),
    ...(input.hashtags === undefined ? {} : { hashtags: input.hashtags }),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.minLikes === undefined ? {} : { minLikes: input.minLikes }),
    ...(input.minRetweets === undefined ? {} : { minRetweets: input.minRetweets }),
    ...(input.minReplies === undefined ? {} : { minReplies: input.minReplies }),
    ...(input.onlyVerified === undefined ? {} : { onlyVerified: input.onlyVerified }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    includeReplies: input.includeReplies,
    includeRetweets: input.includeRetweets,
  };
}

/** The query put to discovery: search terms plus hashtags, with the '#' put back. */
export function topicTerms(input: ActorInput): string[] {
  return [...(input.searchTerms ?? []), ...(input.hashtags ?? []).map((tag) => `#${tag}`)];
}
