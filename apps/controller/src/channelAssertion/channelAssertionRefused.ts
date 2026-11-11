import { problem, type Problem } from '../http/index.js';

/**
 * The one refusal every route reading a channel assertion answers a refused one with, whatever its
 * cause: `401 channelAssertionRefused`, naming the rules an assertion keeps and no cause, so the answer
 * tells no check from another and the cause is in the controller's log alone.
 */
export const CHANNEL_ASSERTION_REFUSED: Problem = problem(
  'channelAssertionRefused',
  401,
  'Channel assertion refused',
  'Send one Bearer channel assertion: HS256 under the channel-assertion subkey of a live key of the application it names in iss, typed usher-channel+jwt, for usher:controller, living at most 60 seconds, current, and with a jti never presented to the stream route before.',
);
