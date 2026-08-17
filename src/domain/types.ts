/**
 * The output contract. Every field is always present and absent values are `null`, never
 * omitted, so the dataset keeps a stable column set.
 */

export type MediaKind = 'photo' | 'video' | 'animated_gif';

export interface TweetMedia {
  readonly type: MediaKind;
  readonly url: string | null;
  readonly thumbnail: string | null;
}

export interface TweetAuthor {
  readonly id: string | null;
  readonly username: string | null;
  readonly name: string | null;
  readonly verified: boolean;
  readonly followers: number | null;
  readonly following: number | null;
}

export interface TweetMetrics {
  readonly likes: number | null;
  readonly retweets: number | null;
  readonly replies: number | null;
  readonly quotes: number | null;
  readonly bookmarks: number | null;
  readonly views: number | null;
}

export interface TweetEntities {
  readonly hashtags: readonly string[];
  readonly mentions: readonly string[];
  readonly urls: readonly string[];
  readonly media: readonly TweetMedia[];
}

export interface Tweet {
  readonly id: string;
  readonly url: string;
  readonly text: string;
  readonly lang: string | null;
  readonly createdAt: string | null;
  readonly conversationId: string | null;
  readonly isReply: boolean;
  readonly isRetweet: boolean;
  readonly isQuote: boolean;
  readonly inReplyToId: string | null;
  readonly quotedTweetId: string | null;
  readonly author: TweetAuthor;
  readonly metrics: TweetMetrics;
  readonly entities: TweetEntities;
  readonly source: string | null;
  readonly scrapedAt: string;
}
