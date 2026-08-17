/**
 * Not a credential and not a secret: a constant embedded in x.com's own bundle and served
 * to every logged-out visitor. Guest auth is the short-lived token we mint per session.
 */
export const PUBLIC_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D' +
  '1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const GUEST_ACTIVATE_URL = 'https://api.x.com/1.1/guest/activate.json';

export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

/** `x.com/` serves a login wall with no app bundle, so queryIds come from `/explore`. */
export const BUNDLE_PAGE = 'https://x.com/explore';
